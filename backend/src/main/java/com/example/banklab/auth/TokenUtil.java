package com.example.banklab.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Simple signed token: base64(username:expiryMillis).signature
 */
public final class TokenUtil {

    private static final String SECRET = "banklab-secret-2019";
    private static final long TTL_MILLIS = 8 * 60 * 60 * 1000L;

    private TokenUtil() {
    }

    public static String issue(String username) {
        long expiry = System.currentTimeMillis() + TTL_MILLIS;
        String payload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString((username + ":" + expiry).getBytes(StandardCharsets.UTF_8));
        return payload + "." + sign(payload);
    }

    /**
     * @return the username, or null if the token is missing, invalid or expired
     */
    public static String verify(String token) {
        if (token == null || !token.contains(".")) {
            return null;
        }
        String[] parts = token.split("\\.");
        if (parts.length != 2) {
            return null;
        }
        if (!MessageDigest.isEqual(sign(parts[0]).getBytes(StandardCharsets.UTF_8),
                parts[1].getBytes(StandardCharsets.UTF_8))) {
            return null;
        }
        try {
            String decoded = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            int idx = decoded.lastIndexOf(':');
            long expiry = Long.parseLong(decoded.substring(idx + 1));
            if (expiry < System.currentTimeMillis()) {
                return null;
            }
            return decoded.substring(0, idx);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String sign(String payload) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
