package com.example.banklab.transfer;

import org.springframework.http.HttpStatus;

import com.example.banklab.common.BusinessException;

public class DailyLimitExceededException extends BusinessException {

    public DailyLimitExceededException() {
        super("LIMIT_EXCEEDED", HttpStatus.UNPROCESSABLE_ENTITY, "Amount exceeds daily limit");
    }
}
