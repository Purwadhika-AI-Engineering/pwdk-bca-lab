package com.example.banklab.labkit;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

class RequestLogFilterTest {

    private final RequestLogFilter filter = new RequestLogFilter();
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();
    private final Logger logger = (Logger) LoggerFactory.getLogger("labkit.request");

    @BeforeEach
    void attach() {
        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void detach() {
        logger.detachAppender(appender);
    }

    private static HttpServlet replying(int status, String body) {
        return new HttpServlet() {
            @Override
            protected void service(HttpServletRequest req, HttpServletResponse res) throws java.io.IOException {
                res.setStatus(status);
                res.setContentType("application/json");
                res.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
            }
        };
    }

    @Test
    @DisplayName("Labkit log: request line has masked path, status and traceId, and no body")
    void logsMaskedRequestLine() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/accounts/1234567890");
        req.addHeader("X-Trace-Id", "trace-12345678");
        MockHttpServletResponse res = new MockHttpServletResponse();

        filter.doFilter(req, res, new MockFilterChain(replying(200, "{\"accountNo\":\"1234567890\",\"owner\":\"Andi Wijaya\"}")));

        List<ILoggingEvent> events = appender.list;
        assertThat(events).hasSize(1);
        ILoggingEvent e = events.get(0);
        assertThat(e.getFormattedMessage()).startsWith("GET /api/accounts/******7890 -> 200 (");
        assertThat(e.getFormattedMessage()).doesNotContain("1234567890").doesNotContain("Andi");
        assertThat(e.getMDCPropertyMap()).containsEntry("traceId", "trace-12345678")
                .containsEntry("status", "200").containsEntry("path", "/api/accounts/******7890");
        assertThat(res.getHeader("X-Trace-Id")).isEqualTo("trace-12345678");
        assertThat(res.getContentAsString()).contains("Andi Wijaya");
    }

    @Test
    @DisplayName("Labkit log: 4xx is a WARN line with the errorCode")
    void logsErrorCodeForClientErrors() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/transfers");
        MockHttpServletResponse res = new MockHttpServletResponse();

        filter.doFilter(req, res, new MockFilterChain(replying(422, "{\"errorCode\":\"INSUFFICIENT_BALANCE\",\"message\":\"x\"}")));

        ILoggingEvent e = appender.list.get(0);
        assertThat(e.getLevel().toString()).isEqualTo("WARN");
        assertThat(e.getMDCPropertyMap()).containsEntry("errorCode", "INSUFFICIENT_BALANCE").containsEntry("status", "422");
        assertThat(res.getHeader("X-Trace-Id")).hasSize(32);
    }

    @Test
    @DisplayName("Labkit log: a bad trace header is replaced")
    void replacesUnsafeTraceHeader() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/accounts");
        req.addHeader("X-Trace-Id", "bad value\n<script>");
        MockHttpServletResponse res = new MockHttpServletResponse();

        filter.doFilter(req, res, new MockFilterChain(replying(200, "[]")));

        assertThat(res.getHeader("X-Trace-Id")).matches("[0-9a-f]{32}");
    }
}
