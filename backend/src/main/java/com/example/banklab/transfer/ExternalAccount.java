package com.example.banklab.transfer;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "external_accounts")
public class ExternalAccount {

    @Id
    private Long id;

    @Column(name = "bank_code")
    private String bankCode;

    @Column(name = "account_no")
    private String accountNo;

    @Column(name = "account_name")
    private String accountName;

    public Long getId() {
        return id;
    }

    public String getBankCode() {
        return bankCode;
    }

    public String getAccountNo() {
        return accountNo;
    }

    public String getAccountName() {
        return accountName;
    }
}
