package com.example.banklab.account;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.Optional;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;

import com.example.banklab.common.ClockConfig;
import com.example.banklab.transfer.TransferRepository;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

@ExtendWith(MockitoExtension.class)
class AccountServiceSummaryTest {

    private static final String ACCOUNT_NO = "1234567890";

    private final ObjectMapper mapper = Jackson2ObjectMapperBuilder.json()
            .featuresToEnable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS).build();

    @Mock
    private AccountRepository accountRepository;

    @Mock
    private TransferRepository transferRepository;

    @Spy
    private Clock clock = Clock.fixed(Instant.parse("2026-03-10T05:00:00Z"), ClockConfig.WIB);

    @InjectMocks
    private AccountService service;

    private Account account() {
        Account a = new Account();
        a.setAccountNo(ACCOUNT_NO);
        a.setUsername("demo");
        a.setOwner("Budi Santoso");
        a.setAccountType("SAVINGS");
        a.setBalanceCents(150000075L);
        a.setCurrency("IDR");
        return a;
    }

    private String summaryJson(BigDecimal used) throws Exception {
        when(accountRepository.findById(ACCOUNT_NO)).thenReturn(Optional.of(account()));
        when(transferRepository.sumAmountSince(eq(ACCOUNT_NO), any(LocalDateTime.class))).thenReturn(used);
        return mapper.writeValueAsString(service.getSummary(ACCOUNT_NO));
    }

    @Test
    @DisplayName("S1 Summary JSON has every field with exact names and values")
    void summaryJsonHasAllFields() throws Exception {
        String json = summaryJson(new BigDecimal("12000000.50"));

        JsonNode node = mapper.readTree(json);
        assertThat(node.size()).isEqualTo(8);
        assertThat(node.get("accountNo").asText()).isEqualTo("1234567890");
        assertThat(node.get("owner").asText()).isEqualTo("Budi Santoso");
        assertThat(node.get("accountType").asText()).isEqualTo("SAVINGS");
        assertThat(node.get("balance").decimalValue()).isEqualByComparingTo("1500000.75");
        assertThat(node.get("currency").asText()).isEqualTo("IDR");
        assertThat(node.get("dailyLimit").decimalValue()).isEqualByComparingTo("50000000.00");
        assertThat(node.get("dailyLimitUsed").decimalValue()).isEqualByComparingTo("12000000.50");
        assertThat(node.get("dailyLimitRemaining").decimalValue()).isEqualByComparingTo("37999999.50");
    }

    @Test
    @DisplayName("S2 Summary JSON text is byte-for-byte stable, including field order")
    void summaryJsonTextIsStable() throws Exception {
        String json = summaryJson(new BigDecimal("12000000.50"));

        assertThat(json).isEqualTo("{\"accountNo\":\"1234567890\",\"owner\":\"Budi Santoso\","
                + "\"accountType\":\"SAVINGS\",\"balance\":1500000.75,\"currency\":\"IDR\","
                + "\"dailyLimit\":50000000.00,\"dailyLimitUsed\":12000000.50,"
                + "\"dailyLimitRemaining\":37999999.50}");
    }

    @Test
    @DisplayName("S3 No transfers today gives used 0.00 and remaining equal to the limit")
    void noTransfersToday() throws Exception {
        String json = summaryJson(null);

        assertThat(json).contains("\"dailyLimitUsed\":0.00").contains("\"dailyLimitRemaining\":50000000.00");
    }

    @Test
    @DisplayName("S4 Used at the daily limit gives remaining zero")
    void usedAtLimitGivesZeroRemaining() throws Exception {
        String json = summaryJson(new BigDecimal("50000000.00"));

        JsonNode node = mapper.readTree(json);
        assertThat(node.get("dailyLimitRemaining").decimalValue()).isEqualByComparingTo("0");
        assertThat(json).contains("\"dailyLimitRemaining\":0.00");
    }
}
