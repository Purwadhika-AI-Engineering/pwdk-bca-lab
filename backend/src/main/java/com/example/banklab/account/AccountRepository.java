package com.example.banklab.account;

import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;

public interface AccountRepository extends JpaRepository<Account, String>, AccountRepositoryCustom {

    List<Account> findByUsername(String username);
}
