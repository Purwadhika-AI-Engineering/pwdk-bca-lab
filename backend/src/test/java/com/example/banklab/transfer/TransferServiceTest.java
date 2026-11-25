package com.example.banklab.transfer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Optional;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;

import com.example.banklab.account.Account;
import com.example.banklab.account.AccountRepository;
import com.example.banklab.common.BusinessException;

/**
 * Unit tests for TransferService rules: minimum (R3), daily limit (R4),
 * same account (R6), owner check (R2) and the 15.00 WIB cut-off (R8).
 * Test data: demo user andi and BRI account 0011223344 from README.md.
 */
@ExtendWith(MockitoExtension.class)
class TransferServiceTest {

    private static final ZoneId JAKARTA = ZoneId.of("Asia/Jakarta");
    private static final LocalDateTime START_OF_DAY = LocalDateTime.of(2026, 11, 11, 0, 0);

    private static final String ANDI_ACCOUNT = "1234567890";
    private static final String BRI_ACCOUNT = "0011223344";

    @Mock
    private AccountRepository accountRepository;

    @Mock
    private TransferRepository transferRepository;

    @Mock
    private ExternalAccountRepository externalAccountRepository;

    @InjectMocks
    private TransferService transferService;

    @Test
    @DisplayName("Amount below Rp10.000 is rejected with BELOW_MINIMUM (R3)")
    void rejectsAmountBelowMinimum() {
        useClockAt("2026-11-11T10:00:00");

        assertThatThrownBy(() -> transferService.transfer(request(ANDI_ACCOUNT, "999", "2345678901", "9999.99")))
                .isInstanceOfSatisfying(BusinessException.class, e -> {
                    assertThat(e.getErrorCode()).isEqualTo("BELOW_MINIMUM");
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
                });
    }

    @Test
    @DisplayName("Same source and target in Lab Bank is rejected with SAME_ACCOUNT (R6)")
    void rejectsSameAccount() {
        useClockAt("2026-11-11T10:00:00");

        assertThatThrownBy(() -> transferService.transfer(request(ANDI_ACCOUNT, "999", ANDI_ACCOUNT, "10000.00")))
                .isInstanceOfSatisfying(BusinessException.class, e -> {
                    assertThat(e.getErrorCode()).isEqualTo("SAME_ACCOUNT");
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
                });
    }

    @Test
    @DisplayName("Source account of another user is rejected with FORBIDDEN (R2)")
    void rejectsSourceAccountOfAnotherUser() {
        useClockAt("2026-11-11T10:00:00");
        when(accountRepository.findById(ANDI_ACCOUNT)).thenReturn(Optional.of(andiAccount()));
        TransferRequest req = request(ANDI_ACCOUNT, "999", "2345678901", "10000.00");
        req.setUsername("budi");

        assertThatThrownBy(() -> transferService.transfer(req))
                .isInstanceOfSatisfying(BusinessException.class, e -> {
                    assertThat(e.getErrorCode()).isEqualTo("FORBIDDEN");
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.FORBIDDEN);
                });
    }

    @Test
    @DisplayName("Amount that goes over the daily limit is rejected with LIMIT_EXCEEDED (R4)")
    void rejectsAmountAboveDailyLimit() {
        useClockAt("2026-11-11T10:00:00");
        when(accountRepository.findById(ANDI_ACCOUNT)).thenReturn(Optional.of(andiAccount()));
        // Rp45.000.000 already sent today, so Rp5.000.000,01 goes over Rp50.000.000
        when(transferRepository.sumAmountSince(eq(ANDI_ACCOUNT), eq(START_OF_DAY)))
                .thenReturn(new BigDecimal("45000000.00"));

        assertThatThrownBy(() ->
                transferService.transfer(request(ANDI_ACCOUNT, "999", "2345678901", "5000000.01")))
                .isInstanceOfSatisfying(BusinessException.class, e -> {
                    assertThat(e.getErrorCode()).isEqualTo("LIMIT_EXCEEDED");
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
                });
    }

    @Test
    @DisplayName("Other bank at 15.00 WIB is accepted as PENDING (R8)")
    void otherBankAtCutOffIsPending() {
        useClockAt("2026-11-11T15:00:00");
        givenOtherBankTransferSetup();

        TransferResponse response =
                transferService.transfer(request(ANDI_ACCOUNT, "002", BRI_ACCOUNT, "1000000.00"));

        assertThat(response.getStatus()).isEqualTo("PENDING");
        assertThat(response.getToBankName()).isEqualTo("BRI");
        assertThat(response.getToName()).isEqualTo("Dewi Anggraini");
        assertThat(response.getAmount()).isEqualByComparingTo("1000000.00");
        assertThat(response.getBalanceAfter()).isEqualTo(7_400_000_000L);
    }

    @Test
    @DisplayName("Other bank at 14.59 WIB is accepted as SUCCESS (R8)")
    void otherBankBeforeCutOffIsSuccess() {
        useClockAt("2026-11-11T14:59:59");
        givenOtherBankTransferSetup();

        TransferResponse response =
                transferService.transfer(request(ANDI_ACCOUNT, "002", BRI_ACCOUNT, "1000000.00"));

        assertThat(response.getStatus()).isEqualTo("SUCCESS");
        assertThat(response.getBalanceAfter()).isEqualTo(7_400_000_000L);
    }

    // ---- helpers ----

    private void givenOtherBankTransferSetup() {
        when(accountRepository.findById(ANDI_ACCOUNT)).thenReturn(Optional.of(andiAccount()));
        when(transferRepository.sumAmountSince(eq(ANDI_ACCOUNT), eq(START_OF_DAY))).thenReturn(null);
        ExternalAccount bri = mock(ExternalAccount.class);
        when(bri.getAccountName()).thenReturn("Dewi Anggraini");
        when(externalAccountRepository.findByBankCodeAndAccountNo("002", BRI_ACCOUNT))
                .thenReturn(Optional.of(bri));
    }

    /** Fixes the clock at the given Jakarta local time. */
    private void useClockAt(String jakartaLocalDateTime) {
        Instant instant = LocalDateTime.parse(jakartaLocalDateTime).atZone(JAKARTA).toInstant();
        ReflectionTestUtils.setField(transferService, "clock", Clock.fixed(instant, JAKARTA));
    }

    private Account andiAccount() {
        Account account = new Account();
        account.setAccountNo(ANDI_ACCOUNT);
        account.setUsername("andi");
        account.setOwner("Andi Wijaya");
        account.setAccountType("SAVINGS");
        account.setBalanceCents(7_500_000_000L); // Rp75.000.000
        account.setCurrency("IDR");
        return account;
    }

    private TransferRequest request(String from, String bankCode, String to, String amount) {
        TransferRequest req = new TransferRequest();
        req.setFromAccount(from);
        req.setToBankCode(bankCode);
        req.setToAccount(to);
        req.setAmount(new BigDecimal(amount));
        req.setUsername("andi");
        return req;
    }
}
