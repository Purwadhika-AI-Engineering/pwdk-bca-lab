package com.example.banklab.labkit;

import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Masks personal data before it goes to the labkit request log (team rules section 3, PRD R12).
 * Account numbers and other long digit runs become ******7890. Query values are hidden,
 * except a few harmless paging parameters.
 */
public final class LogMask {

    private static final Pattern LONG_DIGITS = Pattern.compile("\\d{6,}");
    private static final Set<String> SAFE_PARAMS = Set.of("page", "size", "sort", "limit", "offset", "from", "to", "status");

    private LogMask() {
    }

    /** "1234567890" becomes "******7890". Shorter digit runs stay as they are. */
    public static String digits(String text) {
        if (text == null) {
            return null;
        }
        Matcher m = LONG_DIGITS.matcher(text);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String d = m.group();
            m.appendReplacement(out, "******" + d.substring(d.length() - 4));
        }
        m.appendTail(out);
        return out.toString();
    }

    /** Masks a request path and query string. */
    public static String uri(String path, String query) {
        String masked = digits(path);
        if (query == null || query.isEmpty()) {
            return masked;
        }
        StringBuilder q = new StringBuilder();
        for (String pair : query.split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String key = eq < 0 ? pair : pair.substring(0, eq);
            String value = eq < 0 ? "" : pair.substring(eq + 1);
            if (q.length() > 0) {
                q.append('&');
            }
            q.append(digits(key));
            if (eq >= 0) {
                q.append('=').append(SAFE_PARAMS.contains(key) && value.matches("[A-Za-z0-9_,.:-]{0,40}") ? digits(value) : "***");
            }
        }
        return masked + "?" + q;
    }

    /** "andi" becomes "a***": enough to tell users apart in a lab, not a full name. */
    public static String user(String username) {
        if (username == null || username.isEmpty()) {
            return "-";
        }
        return username.charAt(0) + "***";
    }
}
