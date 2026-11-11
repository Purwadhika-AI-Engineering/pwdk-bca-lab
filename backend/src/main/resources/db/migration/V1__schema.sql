CREATE TABLE users (
    username      VARCHAR(50)  PRIMARY KEY,
    password_hash VARCHAR(64)  NOT NULL,
    full_name     VARCHAR(100) NOT NULL,
    nik           VARCHAR(16)  NOT NULL
);

-- balance is kept in cents (minor units), like the old core system
CREATE TABLE accounts (
    account_no    VARCHAR(10)  PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL REFERENCES users (username),
    owner         VARCHAR(100) NOT NULL,
    account_type  VARCHAR(20)  NOT NULL,
    balance_cents BIGINT       NOT NULL,
    currency      VARCHAR(3)   NOT NULL
);

-- beneficiaries at other banks (stub for the interbank inquiry)
CREATE TABLE external_accounts (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    bank_code    VARCHAR(3)   NOT NULL,
    account_no   VARCHAR(20)  NOT NULL,
    account_name VARCHAR(100) NOT NULL
);

CREATE TABLE transfers (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    reference_no    VARCHAR(20)    NOT NULL,
    idempotency_key VARCHAR(64),
    username        VARCHAR(50)    NOT NULL,
    from_account    VARCHAR(10)    NOT NULL,
    to_bank_code    VARCHAR(3)     NOT NULL,
    to_account      VARCHAR(20)    NOT NULL,
    to_name         VARCHAR(100),
    amount          DECIMAL(19, 2) NOT NULL,
    note            VARCHAR(255),
    status          VARCHAR(20)    NOT NULL,
    created_at      TIMESTAMP      NOT NULL
);
