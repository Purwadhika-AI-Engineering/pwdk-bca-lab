package com.example.banklab.account;

import java.util.List;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

public class AccountRepositoryCustomImpl implements AccountRepositoryCustom {

    @Autowired
    private JdbcTemplate jdbc;

    private final RowMapper<Account> mapper = (rs, rowNum) -> {
        Account a = new Account();
        a.setAccountNo(rs.getString("account_no"));
        a.setUsername(rs.getString("username"));
        a.setOwner(rs.getString("owner"));
        a.setAccountType(rs.getString("account_type"));
        a.setBalanceCents(rs.getLong("balance_cents"));
        a.setCurrency(rs.getString("currency"));
        return a;
    };

    @Override
    public List<Account> findByOwnerName(String ownerName) {
        String sql = "SELECT * FROM accounts"
                + " WHERE owner = '" + ownerName + "'";
        return jdbc.query(sql, mapper);
    }
}
