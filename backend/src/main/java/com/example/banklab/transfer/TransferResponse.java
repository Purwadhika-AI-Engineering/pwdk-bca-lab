package com.example.banklab.transfer;

import java.math.BigDecimal;
import java.time.LocalDateTime;

public class TransferResponse {

    private String referenceNo;
    private String status;
    private String fromAccount;
    private String toBankCode;
    private String toBankName;
    private String toAccount;
    private String toName;
    private BigDecimal amount;
    private String note;
    private LocalDateTime createdAt;
    private Long balanceAfter;

    public static TransferResponse from(Transfer t) {
        TransferResponse r = new TransferResponse();
        r.referenceNo = t.getReferenceNo();
        r.status = t.getStatus();
        r.fromAccount = t.getFromAccount();
        r.toBankCode = t.getToBankCode();
        r.toBankName = TransferService.BANKS.get(t.getToBankCode());
        r.toAccount = t.getToAccount();
        r.toName = t.getToName();
        r.amount = t.getAmount();
        r.note = t.getNote();
        r.createdAt = t.getCreatedAt();
        return r;
    }

    public String getReferenceNo() {
        return referenceNo;
    }

    public String getStatus() {
        return status;
    }

    public String getFromAccount() {
        return fromAccount;
    }

    public String getToBankCode() {
        return toBankCode;
    }

    public String getToBankName() {
        return toBankName;
    }

    public String getToAccount() {
        return toAccount;
    }

    public String getToName() {
        return toName;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public String getNote() {
        return note;
    }

    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public Long getBalanceAfter() {
        return balanceAfter;
    }

    public void setBalanceAfter(Long balanceAfter) {
        this.balanceAfter = balanceAfter;
    }
}
