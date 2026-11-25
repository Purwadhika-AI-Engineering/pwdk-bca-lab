package com.example.banklab.account;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;
import org.springframework.test.util.ReflectionTestUtils;

import com.example.banklab.common.BusinessException;
import com.example.banklab.transfer.TransferRepository;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Pins the JSON of GET /api/accounts/{id}/summary (field names, order and values)
 * as produced from AccountService.getSummary().
 */
@ExtendWith(MockitoExtension.class)
class AccountServiceTest {

    private static final String BUDI_ACCOUNT = "2345678901";

    // 2026-11-10T20:00Z = 2026-11-11 03:00 WIB. Start of day must be the Jakarta date, not the UTC date.
    private static final Clock FIXED_CLOCK =
            Clock.fixed(Instant.parse("2026-11-10T20:00:00Z"), ZoneId.of("Asia/Jakarta"));
    private static final LocalDateTime JAKARTA_START_OF_DAY = LocalDateTime.of(2026, 11, 11, 0, 0);

    // Same builder Spring Boot uses for its ObjectMapper; no spring.jackson.* properties are set in this app.
    private final ObjectMapper objectMapper = Jackson2ObjectMapperBuilder.json().build();

    @Mock
    private AccountRepository accountRepository;

    @Mock
    private TransferRepository transferRepository;

    @InjectMocks
    private AccountService accountService;

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(accountService, "clock", FIXED_CLOCK);
    }

    @Test
    @DisplayName("Summary JSON has every field with exact names and values")
    void summaryJsonHasEveryFieldWithExactValues() throws Exception {
        givenBudiAccount();
        when(transferRepository.sumAmountSince(BUDI_ACCOUNT, JAKARTA_START_OF_DAY))
                .thenReturn(new BigDecimal("100000.00"));

        String json = objectMapper.writeValueAsString(accountService.getSummary(BUDI_ACCOUNT));

        assertThat(json).isEqualTo("{"
                + "\"accountNo\":\"2345678901\","
                + "\"owner\":\"Budi Santoso\","
                + "\"accountType\":\"SAVINGS\","
                + "\"balance\":12500000.00,"
                + "\"currency\":\"IDR\","
                + "\"dailyLimit\":50000000.00,"
                + "\"dailyLimitUsed\":100000.00,"
                + "\"dailyLimitRemaining\":49900000.00"
                + "}");
    }

    @Test
    @DisplayName("No transfers today gives used 0.00 and the full daily limit remaining")
    void noTransfersTodayGivesZeroUsedAndFullLimit() throws Exception {
        givenBudiAccount();
        when(transferRepository.sumAmountSince(BUDI_ACCOUNT, JAKARTA_START_OF_DAY)).thenReturn(null);

        String json = objectMapper.writeValueAsString(accountService.getSummary(BUDI_ACCOUNT));

        assertThat(json).isEqualTo("{"
                + "\"accountNo\":\"2345678901\","
                + "\"owner\":\"Budi Santoso\","
                + "\"accountType\":\"SAVINGS\","
                + "\"balance\":12500000.00,"
                + "\"currency\":\"IDR\","
                + "\"dailyLimit\":50000000.00,"
                + "\"dailyLimitUsed\":0.00,"
                + "\"dailyLimitRemaining\":50000000.00"
                + "}");
    }

    @Test
    @DisplayName("Daily limit fully used gives remaining 0.00")
    void dailyLimitFullyUsedGivesZeroRemaining() throws Exception {
        givenBudiAccount();
        when(transferRepository.sumAmountSince(BUDI_ACCOUNT, JAKARTA_START_OF_DAY))
                .thenReturn(new BigDecimal("50000000.00"));

        String json = objectMapper.writeValueAsString(accountService.getSummary(BUDI_ACCOUNT));

        assertThat(json).isEqualTo("{"
                + "\"accountNo\":\"2345678901\","
                + "\"owner\":\"Budi Santoso\","
                + "\"accountType\":\"SAVINGS\","
                + "\"balance\":12500000.00,"
                + "\"currency\":\"IDR\","
                + "\"dailyLimit\":50000000.00,"
                + "\"dailyLimitUsed\":50000000.00,"
                + "\"dailyLimitRemaining\":0.00"
                + "}");
    }

    @Test
    @DisplayName("Unknown account gives ACCOUNT_NOT_FOUND 404")
    void unknownAccountGivesAccountNotFound() {
        when(accountRepository.findById("9999999999")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> accountService.getSummary("9999999999"))
                .isInstanceOfSatisfying(BusinessException.class, e -> {
                    assertThat(e.getErrorCode()).isEqualTo("ACCOUNT_NOT_FOUND");
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.NOT_FOUND);
                    assertThat(e.getMessage()).isEqualTo("Account not found");
                });
    }

    private void givenBudiAccount() {
        Account account = new Account();
        account.setAccountNo(BUDI_ACCOUNT);
        account.setUsername("budi");
        account.setOwner("Budi Santoso");
        account.setAccountType("SAVINGS");
        account.setBalanceCents(1_250_000_000L);
        account.setCurrency("IDR");
        when(accountRepository.findById(BUDI_ACCOUNT)).thenReturn(Optional.of(account));
    }
}
