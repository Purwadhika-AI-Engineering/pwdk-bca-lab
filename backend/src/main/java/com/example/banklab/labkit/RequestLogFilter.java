package com.example.banklab.labkit;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;

import com.example.banklab.auth.AuthFilter;

/**
 * Labkit only: one log line per /api request, for the Grafana mock.
 * Fields: method, path (masked), status, duration_ms, traceId, user (masked) and, for errors,
 * the errorCode from the response. It never logs request or response bodies.
 * It runs before AuthFilter, so 401 responses are logged too.
 */
@Component
@Profile("labkit")
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestLogFilter extends OncePerRequestFilter {

    static final String TRACE_HEADER = "X-Trace-Id";
    private static final Logger log = LoggerFactory.getLogger("labkit.request");
    private static final Pattern SAFE_TRACE = Pattern.compile("[A-Za-z0-9-]{8,64}");
    private static final Pattern ERROR_CODE = Pattern.compile("\"errorCode\"\\s*:\\s*\"([A-Z0-9_]{1,64})\"");

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith("/api/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String incoming = request.getHeader(TRACE_HEADER);
        String traceId = incoming != null && SAFE_TRACE.matcher(incoming).matches()
                ? incoming
                : UUID.randomUUID().toString().replace("-", "");
        response.setHeader(TRACE_HEADER, traceId);
        ContentCachingResponseWrapper wrapped = new ContentCachingResponseWrapper(response);
        long start = System.nanoTime();
        int status = 500;
        MDC.put("traceId", traceId);
        try {
            chain.doFilter(request, wrapped);
            status = wrapped.getStatus();
        } finally {
            long ms = (System.nanoTime() - start) / 1_000_000;
            String errorCode = status >= 400 ? errorCode(wrapped) : null;
            String path = LogMask.uri(request.getRequestURI(), request.getQueryString());
            Object user = request.getAttribute(AuthFilter.USERNAME_ATTR);
            try {
                MDC.put("method", request.getMethod());
                MDC.put("path", path);
                MDC.put("status", String.valueOf(status));
                MDC.put("duration_ms", String.valueOf(ms));
                MDC.put("user", LogMask.user(user == null ? null : user.toString()));
                if (errorCode != null) {
                    MDC.put("errorCode", errorCode);
                }
                String line = "{} {} -> {} ({} ms){}";
                Object[] args = {request.getMethod(), path, status, ms, errorCode == null ? "" : " " + errorCode};
                if (status >= 500) {
                    log.error(line, args);
                } else if (status >= 400) {
                    log.warn(line, args);
                } else {
                    log.info(line, args);
                }
            } finally {
                MDC.remove("method");
                MDC.remove("path");
                MDC.remove("status");
                MDC.remove("duration_ms");
                MDC.remove("user");
                MDC.remove("errorCode");
                MDC.remove("traceId");
                wrapped.copyBodyToResponse();
            }
        }
    }

    private static String errorCode(ContentCachingResponseWrapper response) {
        byte[] body = response.getContentAsByteArray();
        if (body.length == 0 || body.length > 4096) {
            return null;
        }
        Matcher m = ERROR_CODE.matcher(new String(body, StandardCharsets.UTF_8));
        return m.find() ? m.group(1) : null;
    }
}
