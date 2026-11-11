package com.example.banklab.account;

import java.math.BigDecimal;

public class AccountView {

    private String accountNo;
    private String owner;
    private String accountType;
    private BigDecimal balance;
    private String currency;

    public static AccountView from(Account a) {
        AccountView v = new AccountView();
        v.accountNo = a.getAccountNo();
        v.owner = a.getOwner();
        v.accountType = a.getAccountType();
        v.balance = BigDecimal.valueOf(a.getBalanceCents(), 2);
        v.currency = a.getCurrency();
        return v;
    }

    public String getAccountNo() {
        return accountNo;
    }

    public String getOwner() {
        return owner;
    }

    public String getAccountType() {
        return accountType;
    }

    public BigDecimal getBalance() {
        return balance;
    }

    public String getCurrency() {
        return currency;
    }
}
