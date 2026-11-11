package com.example.banklab.transfer;

import java.util.List;
import java.util.Map;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.example.banklab.auth.AuthFilter;

@RestController
@RequestMapping("/api/transfers")
public class TransferController {

    @Autowired
    private TransferService transferService;

    @PostMapping("/inquiry")
    public InquiryResponse inquiry(@RequestBody Map<String, String> body) {
        return transferService.inquiry(body.get("bankCode"), body.get("accountNo"));
    }

    @PostMapping
    public ResponseEntity<TransferResponse> transfer(
            @RequestBody TransferRequest request,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestAttribute(value = AuthFilter.USERNAME_ATTR, required = false) String username) {
        request.setUsername(username);
        request.setIdempotencyKey(idempotencyKey);
        return ResponseEntity.status(HttpStatus.CREATED).body(transferService.transfer(request));
    }

    @GetMapping
    public List<TransferResponse> history(
            @RequestAttribute(value = AuthFilter.USERNAME_ATTR, required = false) String username) {
        return transferService.history(username);
    }
}
