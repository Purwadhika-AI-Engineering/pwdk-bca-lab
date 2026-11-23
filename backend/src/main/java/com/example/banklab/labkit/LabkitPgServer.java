package com.example.banklab.labkit;

import java.lang.reflect.Method;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import jakarta.annotation.PreDestroy;

/**
 * Labkit only: a read-only "staging DB" over the Postgres wire protocol on 127.0.0.1,
 * so labkit/mcp/db.mjs can query the app data.
 *
 * How it works:
 * 1. In the app database, a user that can only SELECT a few tables.
 * 2. A second in-memory database in PostgreSQL mode. It holds READONLY linked tables
 *    that read the app tables live, through the user from step 1.
 *    (The H2 PG server needs PostgreSQL mode, and only an admin can switch the app DB.)
 * 3. The same read-only user in the second database, with SELECT on the linked tables.
 * 4. The H2 PG server, which maps the database name "banklab" to the second database.
 *
 * H2 is a runtime dependency, so the server class is loaded by reflection.
 */
@Component
@Profile("labkit")
public class LabkitPgServer {

    private static final Logger log = LoggerFactory.getLogger(LabkitPgServer.class);

    /** Tables the read-only user may read. The users table (NIK, password hash) is left out on purpose. */
    static final List<String> READABLE_TABLES = List.of("accounts", "transfers", "external_accounts");

    static final String STAGING_DB = "mem:labkit_staging";
    private static final String STAGING_SETTINGS =
            ";DB_CLOSE_DELAY=-1;MODE=PostgreSQL;DEFAULT_NULL_ORDERING=HIGH;TRACE_LEVEL_FILE=0";

    private final JdbcTemplate jdbc;
    private final int port;
    private final String roUser;
    private final String roPassword;
    private Connection staging;
    private Object server;

    public LabkitPgServer(JdbcTemplate jdbc,
                          @Value("${labkit.db.port:5435}") int port,
                          @Value("${labkit.db.user:labkit_ro}") String roUser,
                          @Value("${labkit.db.password}") String roPassword) {
        this.jdbc = jdbc;
        this.port = port;
        this.roUser = roUser;
        this.roPassword = roPassword;
        if (!roUser.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            throw new IllegalArgumentException("labkit.db.user must be a plain identifier");
        }
    }

    @EventListener(ApplicationReadyEvent.class)
    public void start() throws Exception {
        String user = roUser.toUpperCase();
        String password = roPassword.replace("'", "''");

        // 1. read-only user in the app database
        jdbc.execute("CREATE USER IF NOT EXISTS " + user + " PASSWORD '" + password + "'");
        for (String table : READABLE_TABLES) {
            jdbc.execute("GRANT SELECT ON " + table.toUpperCase() + " TO " + user);
        }

        // 2. + 3. staging database with read-only linked tables
        staging = DriverManager.getConnection("jdbc:h2:" + STAGING_DB + STAGING_SETTINGS, "sa", "");
        try (Statement st = staging.createStatement()) {
            st.execute("CREATE USER IF NOT EXISTS " + user + " PASSWORD '" + password + "'");
            for (String table : READABLE_TABLES) {
                st.execute("CREATE LINKED TABLE IF NOT EXISTS " + table
                        + "('org.h2.Driver', 'jdbc:h2:mem:banklab', '" + user + "', '" + password + "', '"
                        + table.toUpperCase() + "') READONLY");
                st.execute("GRANT SELECT ON " + table + " TO " + user);
            }
        }

        // 4. Postgres protocol server. No -pgAllowOthers: local connections only.
        // LabkitEnvironment binds it to 127.0.0.1. IGNORE_UNKNOWN_SETTINGS lets the
        // read-only user skip the admin-only settings the PG server sends on connect.
        Class<?> serverClass = Class.forName("org.h2.tools.Server");
        Method create = serverClass.getMethod("createPgServer", String[].class);
        String[] args = {"-pgPort", String.valueOf(port), "-ifExists",
                "-key", "banklab", STAGING_DB + ";IGNORE_UNKNOWN_SETTINGS=TRUE"};
        server = create.invoke(null, (Object) args);
        serverClass.getMethod("start").invoke(server);
        log.info("Labkit DB (Postgres protocol) on 127.0.0.1:{}, database banklab, read-only user {}", port, roUser);
    }

    @PreDestroy
    public void stop() {
        try {
            if (server != null) {
                server.getClass().getMethod("stop").invoke(server);
            }
            if (staging != null) {
                staging.close();
            }
        } catch (ReflectiveOperationException | SQLException e) {
            log.warn("Could not stop the labkit DB server: {}", e.toString());
        }
    }
}
