package com.example.banklab.transfer;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import com.example.banklab.account.Account;
import com.example.banklab.account.AccountRepository;
import com.example.banklab.common.BusinessException;

@Service
public class TransferService {

    private static final Logger log = LoggerFactory.getLogger(TransferService.class);

    public static final BigDecimal DAILY_LIMIT = new BigDecimal("50000000.00");
    public static final BigDecimal MIN_AMOUNT = new BigDecimal("10000.00");
    public static final LocalTime CUT_OFF = LocalTime.of(15, 0);

    public static final String OWN_BANK = "999";
    public static final Map<String, String> BANKS = Map.of(
            "999", "Lab Bank",
            "002", "BRI",
            "008", "Bank Mandiri",
            "009", "BNI");

    private static final String REF_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    private static final SecureRandom RANDOM = new SecureRandom();

    @Autowired
    private AccountRepository accountRepository;

    @Autowired
    private TransferRepository transferRepository;

    @Autowired
    private ExternalAccountRepository externalAccountRepository;

    @Autowired
    private Clock clock;

    public InquiryResponse inquiry(String bankCode, String accountNo) {
        if (bankCode == null || accountNo == null) {
            throw new IllegalArgumentException("bankCode and accountNo are required");
        }
        String bankName = BANKS.get(bankCode);
        if (bankName == null) {
            throw new BusinessException("BANK_NOT_SUPPORTED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "Bank is not supported");
        }
        if (OWN_BANK.equals(bankCode)) {
            Account a = accountRepository.findById(accountNo)
                    .orElseThrow(() -> new BusinessException("ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND,
                            "Beneficiary account not found"));
            return new InquiryResponse(bankCode, bankName, a.getAccountNo(), a.getOwner());
        }
        ExternalAccount ext = externalAccountRepository.findByBankCodeAndAccountNo(bankCode, accountNo)
                .orElseThrow(() -> new BusinessException("ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "Beneficiary account not found"));
        return new InquiryResponse(bankCode, bankName, ext.getAccountNo(), ext.getAccountName());
    }

    public TransferResponse transfer(String fromAccount, String toAccount, BigDecimal amount) {
        TransferRequest req = new TransferRequest();
        req.setFromAccount(fromAccount);
        req.setToAccount(toAccount);
        req.setToBankCode(OWN_BANK);
        req.setAmount(amount);
        return transfer(req);
    }

    public TransferResponse transfer(TransferRequest req) {
        // 1. basic checks
        if (req.getAmount() == null || req.getAmount().signum() <= 0) {
            throw new IllegalArgumentException("Amount must be more than 0");
        }
        if (req.getFromAccount() == null || req.getToAccount() == null) {
            throw new IllegalArgumentException("fromAccount and toAccount are required");
        }
        BigDecimal amount = req.getAmount().setScale(2, RoundingMode.HALF_UP);
        String bankCode = req.getToBankCode() == null ? OWN_BANK : req.getToBankCode();
        if (!BANKS.containsKey(bankCode)) {
            throw new BusinessException("BANK_NOT_SUPPORTED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "Bank is not supported");
        }
        if (amount.compareTo(MIN_AMOUNT) < 0) {
            throw new BusinessException("BELOW_MINIMUM", HttpStatus.UNPROCESSABLE_ENTITY,
                    "Minimum transfer is Rp10.000");
        }
        if (OWN_BANK.equals(bankCode) && req.getFromAccount().equals(req.getToAccount())) {
            throw new BusinessException("SAME_ACCOUNT", HttpStatus.UNPROCESSABLE_ENTITY,
                    "Source and target account must be different");
        }

        // 2. source account
        Account from = accountRepository.findById(req.getFromAccount())
                .orElseThrow(() -> new BusinessException("ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "Source account not found"));
        if (req.getUsername() != null && !req.getUsername().equals(from.getUsername())) {
            throw new BusinessException("FORBIDDEN", HttpStatus.FORBIDDEN,
                    "Source account does not belong to the user");
        }

        // 3. same request sent again -> return the first result
        if (req.getIdempotencyKey() != null) {
            Optional<Transfer> existing = transferRepository
                    .findFirstByUsernameAndIdempotencyKey(req.getUsername(), req.getIdempotencyKey());
            if (existing.isPresent()) {
                TransferResponse r = TransferResponse.from(existing.get());
                r.setBalanceAfter(from.getBalanceCents());
                return r;
            }
        }

        // 4. daily limit
        if (amount.compareTo(DAILY_LIMIT) > 0) {
            throw new DailyLimitExceededException();
        }
        LocalDateTime now = LocalDateTime.now(clock);
        BigDecimal usedToday = transferRepository.sumAmountSince(from.getAccountNo(),
                LocalDate.now(clock).atStartOfDay());
        if (usedToday == null) {
            usedToday = BigDecimal.ZERO;
        }
        if (usedToday.add(amount).compareTo(DAILY_LIMIT) > 0) {
            throw new DailyLimitExceededException();
        }

        // 5. balance
        long amountCents = amount.movePointRight(2).longValueExact();
        if (from.getBalanceCents() < amountCents) {
            throw new BusinessException("INSUFFICIENT_FUNDS", HttpStatus.UNPROCESSABLE_ENTITY,
                    "Insufficient balance");
        }

        // 6. target account
        Account to = null;
        String toName;
        if (OWN_BANK.equals(bankCode)) {
            to = accountRepository.findById(req.getToAccount())
                    .orElseThrow(() -> new BusinessException("ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND,
                            "Beneficiary account not found"));
            toName = to.getOwner();
        } else {
            toName = externalAccountRepository.findByBankCodeAndAccountNo(bankCode, req.getToAccount())
                    .orElseThrow(() -> new BusinessException("ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND,
                            "Beneficiary account not found"))
                    .getAccountName();
        }

        // 7. status: other banks after cut-off are sent next business day
        String status = "SUCCESS";
        if (!OWN_BANK.equals(bankCode) && !now.toLocalTime().isBefore(CUT_OFF)) {
            status = "PENDING";
        }

        // 8. debit and credit
        from.setBalanceCents(from.getBalanceCents() - amountCents);
        accountRepository.save(from);
        if (to != null) {
            to.setBalanceCents(to.getBalanceCents() + amountCents);
            accountRepository.save(to);
        }

        // 9. save the transfer
        Transfer t = new Transfer();
        t.setReferenceNo(newReferenceNo(now));
        t.setIdempotencyKey(req.getIdempotencyKey());
        t.setUsername(from.getUsername());
        t.setFromAccount(from.getAccountNo());
        t.setToBankCode(bankCode);
        t.setToAccount(req.getToAccount());
        t.setToName(toName);
        t.setAmount(amount);
        t.setNote(req.getNote());
        t.setStatus(status);
        t.setCreatedAt(now);
        transferRepository.save(t);

        log.info("Transfer {} from={} to={} bank={} amount={} status={}",
                t.getReferenceNo(), from.getAccountNo(), req.getToAccount(), bankCode, amount, status);

        TransferResponse response = TransferResponse.from(t);
        response.setBalanceAfter(from.getBalanceCents());
        return response;
    }

    public List<TransferResponse> history(String username) {
        return transferRepository.findByUsernameOrderByCreatedAtDesc(username).stream()
                .map(TransferResponse::from)
                .collect(Collectors.toList());
    }

    private String newReferenceNo(LocalDateTime now) {
        StringBuilder sb = new StringBuilder("TRF").append(now.format(DateTimeFormatter.BASIC_ISO_DATE));
        for (int i = 0; i < 6; i++) {
            sb.append(REF_CHARS.charAt(RANDOM.nextInt(REF_CHARS.length())));
        }
        return sb.toString();
    }
}
