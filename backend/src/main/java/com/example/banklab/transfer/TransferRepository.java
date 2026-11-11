package com.example.banklab.transfer;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface TransferRepository extends JpaRepository<Transfer, Long> {

    List<Transfer> findByUsernameOrderByCreatedAtDesc(String username);

    Optional<Transfer> findFirstByUsernameAndIdempotencyKey(String username, String idempotencyKey);

    /** Sum of transfers from this account since the given time; null when there are none. */
    @Query("select sum(t.amount) from Transfer t where t.fromAccount = :accountNo and t.createdAt >= :since")
    BigDecimal sumAmountSince(@Param("accountNo") String accountNo, @Param("since") LocalDateTime since);
}
