package com.example.banklab.account;

import java.math.BigDecimal;

public record AccountSummary(
        String accountNo,
        String owner,
        String accountType,
        BigDecimal balance,
        String currency,
        BigDecimal dailyLimit,
        BigDecimal dailyLimitUsed,
        BigDecimal dailyLimitRemaining) {
}
