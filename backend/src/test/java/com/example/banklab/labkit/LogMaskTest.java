package com.example.banklab.labkit;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class LogMaskTest {

    @Test
    @DisplayName("Labkit log: account number in a path is masked (R12)")
    void masksAccountNumberInPath() {
        assertThat(LogMask.uri("/api/accounts/1234567890/summary", null)).isEqualTo("/api/accounts/******7890/summary");
    }

    @Test
    @DisplayName("Labkit log: external account numbers of any length are masked (R12)")
    void masksLongExternalAccountNumber() {
        assertThat(LogMask.digits("to 1370012345678")).isEqualTo("to ******5678");
    }

    @Test
    @DisplayName("Labkit log: short numbers stay readable")
    void keepsShortNumbers() {
        assertThat(LogMask.uri("/api/transfers/42", null)).isEqualTo("/api/transfers/42");
    }

    @Test
    @DisplayName("Labkit log: query values that may hold names are hidden")
    void hidesQueryValues() {
        assertThat(LogMask.uri("/api/accounts/search", "owner=Andi%20Wijaya&page=2"))
                .isEqualTo("/api/accounts/search?owner=***&page=2");
    }

    @Test
    @DisplayName("Labkit log: account number in a safe query param is still masked")
    void masksDigitsInSafeParam() {
        assertThat(LogMask.uri("/api/transfers", "from=2345678901")).isEqualTo("/api/transfers?from=******8901");
    }

    @Test
    @DisplayName("Labkit log: username is shortened")
    void shortensUser() {
        assertThat(LogMask.user("andi")).isEqualTo("a***");
        assertThat(LogMask.user(null)).isEqualTo("-");
    }
}
