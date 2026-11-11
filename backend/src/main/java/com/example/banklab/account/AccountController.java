package com.example.banklab.account;

import java.util.List;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/accounts")
public class AccountController {

    @Autowired
    private AccountService accountService;

    @GetMapping
    public List<AccountView> findByOwner(@RequestParam("owner") String owner) {
        return accountService.findByOwner(owner);
    }

    @GetMapping("/{id}")
    public AccountView getAccount(@PathVariable("id") String id) {
        return accountService.getAccount(id);
    }

    @GetMapping("/{id}/summary")
    public AccountSummary getSummary(@PathVariable("id") String id) {
        return accountService.getSummary(id);
    }
}
