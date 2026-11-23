package com.example.banklab.labkit;

import java.util.Arrays;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;

/**
 * Labkit only: runs before any bean is created. When the "labkit" profile is active,
 * it tells H2 to bind its servers to 127.0.0.1 (no firewall prompt on Windows).
 * H2 reads this system property once, so it must be set before H2 loads.
 */
public class LabkitEnvironment implements EnvironmentPostProcessor {

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        if (Arrays.asList(environment.getActiveProfiles()).contains("labkit")) {
            System.setProperty("h2.bindAddress", "127.0.0.1");
        }
    }
}
