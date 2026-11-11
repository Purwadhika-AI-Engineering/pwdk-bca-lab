package com.example.banklab.transfer;

import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

public interface ExternalAccountRepository extends JpaRepository<ExternalAccount, Long> {

    Optional<ExternalAccount> findByBankCodeAndAccountNo(String bankCode, String accountNo);
}
