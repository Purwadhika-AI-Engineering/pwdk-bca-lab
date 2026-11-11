package com.example.banklab.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.example.banklab.common.BusinessException;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private static final Logger log = LoggerFactory.getLogger(AuthController.class);

    @Autowired
    private UserRepository userRepository;

    @PostMapping("/login")
    public Map<String, String> login(@RequestBody Map<String, String> body) {
        String username = body.get("username");
        String password = body.get("password");
        if (username == null || password == null) {
            throw new IllegalArgumentException("username and password are required");
        }

        Optional<User> user = userRepository.findById(username);
        if (user.isEmpty() || !user.get().getPasswordHash().equals(sha256(password))) {
            throw new BusinessException("INVALID_CREDENTIALS", HttpStatus.UNAUTHORIZED,
                    "Invalid user ID or password");
        }

        User u = user.get();
        log.info("Login success user={} name={} nik={}", u.getUsername(), u.getFullName(), u.getNik());
        return Map.of(
                "token", TokenUtil.issue(u.getUsername()),
                "username", u.getUsername(),
                "fullName", u.getFullName());
    }

    private static String sha256(String value) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
