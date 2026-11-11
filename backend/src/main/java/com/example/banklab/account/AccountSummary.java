package com.example.banklab.account;

import java.math.BigDecimal;

public class AccountSummary {

    private String accountNo;
    private String owner;
    private String accountType;
    private BigDecimal balance;
    private String currency;
    private BigDecimal dailyLimit;
    private BigDecimal dailyLimitUsed;
    private BigDecimal dailyLimitRemaining;

    public String getAccountNo() {
        return accountNo;
    }

    public void setAccountNo(String accountNo) {
        this.accountNo = accountNo;
    }

    public String getOwner() {
        return owner;
    }

    public void setOwner(String owner) {
        this.owner = owner;
    }

    public String getAccountType() {
        return accountType;
    }

    public void setAccountType(String accountType) {
        this.accountType = accountType;
    }

    public BigDecimal getBalance() {
        return balance;
    }

    public void setBalance(BigDecimal balance) {
        this.balance = balance;
    }

    public String getCurrency() {
        return currency;
    }

    public void setCurrency(String currency) {
        this.currency = currency;
    }

    public BigDecimal getDailyLimit() {
        return dailyLimit;
    }

    public void setDailyLimit(BigDecimal dailyLimit) {
        this.dailyLimit = dailyLimit;
    }

    public BigDecimal getDailyLimitUsed() {
        return dailyLimitUsed;
    }

    public void setDailyLimitUsed(BigDecimal dailyLimitUsed) {
        this.dailyLimitUsed = dailyLimitUsed;
    }

    public BigDecimal getDailyLimitRemaining() {
        return dailyLimitRemaining;
    }

    public void setDailyLimitRemaining(BigDecimal dailyLimitRemaining) {
        this.dailyLimitRemaining = dailyLimitRemaining;
    }
}
