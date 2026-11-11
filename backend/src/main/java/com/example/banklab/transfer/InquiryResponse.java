package com.example.banklab.transfer;

public class InquiryResponse {

    private String bankCode;
    private String bankName;
    private String accountNo;
    private String accountName;

    public InquiryResponse(String bankCode, String bankName, String accountNo, String accountName) {
        this.bankCode = bankCode;
        this.bankName = bankName;
        this.accountNo = accountNo;
        this.accountName = accountName;
    }

    public String getBankCode() {
        return bankCode;
    }

    public String getBankName() {
        return bankName;
    }

    public String getAccountNo() {
        return accountNo;
    }

    public String getAccountName() {
        return accountName;
    }
}
