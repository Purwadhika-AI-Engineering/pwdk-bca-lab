package com.example.banklab.account;

import java.util.List;

public interface AccountRepositoryCustom {

    List<Account> findByOwnerName(String ownerName);
}
