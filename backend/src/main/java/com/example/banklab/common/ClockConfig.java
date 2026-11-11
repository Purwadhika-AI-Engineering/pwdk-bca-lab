package com.example.banklab.common;

import java.time.Clock;
import java.time.ZoneId;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ClockConfig {

    public static final ZoneId WIB = ZoneId.of("Asia/Jakarta");

    @Bean
    public Clock clock() {
        return Clock.system(WIB);
    }
}
