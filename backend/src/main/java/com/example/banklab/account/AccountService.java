package com.example.banklab.account;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import java.util.stream.Collectors;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import com.example.banklab.common.BusinessException;
import com.example.banklab.transfer.TransferRepository;
import com.example.banklab.transfer.TransferService;

@Service
public class AccountService {

    @Autowired
    private AccountRepository accountRepository;

    @Autowired
    private TransferRepository transferRepository;

    @Autowired
    private Clock clock;

    public List<AccountView> findByOwner(String ownerName) {
        return accountRepository.findByOwnerName(ownerName).stream()
                .map(AccountView::from)
                .collect(Collectors.toList());
    }

    public AccountView getAccount(String accountNo) {
        return AccountView.from(load(accountNo));
    }

    public AccountSummary getSummary(String accountNo) {
        Account a = load(accountNo);
        LocalDateTime startOfDay = LocalDate.now(clock).atStartOfDay();
        BigDecimal used = transferRepository.sumAmountSince(accountNo, startOfDay);
        if (used == null) {
            used = BigDecimal.ZERO.setScale(2);
        }

        AccountSummary s = new AccountSummary();
        s.setAccountNo(a.getAccountNo());
        s.setOwner(a.getOwner());
        s.setAccountType(a.getAccountType());
        s.setBalance(BigDecimal.valueOf(a.getBalanceCents(), 2));
        s.setCurrency(a.getCurrency());
        s.setDailyLimit(TransferService.DAILY_LIMIT);
        s.setDailyLimitUsed(used);
        s.setDailyLimitRemaining(TransferService.DAILY_LIMIT.subtract(used).max(BigDecimal.ZERO));
        return s;
    }

    private Account load(String accountNo) {
        return accountRepository.findById(accountNo)
                .orElseThrow(() -> new BusinessException("ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "Account not found"));
    }
}
