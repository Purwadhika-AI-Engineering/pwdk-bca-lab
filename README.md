# Lab Bank: transfer app

A small banking app for the training labs. Users log in, check their balance, and transfer money to another account at Lab Bank or at another bank.

This is legacy-style code: it works, but it has no tests and no steering files yet. You add those during the labs, using `docs/team-rules.md` as the source.

| Folder | What it is |
|---|---|
| `backend/` | Spring Boot 3.5, Java 17, Maven, H2 in-memory database, Flyway |
| `frontend/` | Angular 17 (standalone components), Jasmine + Karma |
| `docs/PRD.md` | Product rules for the transfer feature |
| `docs/team-rules.md` | Team coding, test and security rules (dummy), the source for your steering files |
| `templates/test-cases.md` | Format for the test-case list. In Lab 2 you fill it and save it as `docs/test-cases.md` |
| `postman/` | Postman collection and the `sit` environment |

## Run it

Step-by-step guide: open `../setup.html` in a browser.

Start the backend one way and the frontend one way. Any mix works: the backend is always on port 8080, the frontend on port 4200.

| Part | Option | Command (folder) |
|---|---|---|
| Backend | Docker | `docker compose up --build backend` (`lab`) |
| Backend | IntelliJ | Open `backend`, set SDK to JDK 17, run **BankLabApplication** |
| Backend | Maven | `./mvnw spring-boot:run`, on Windows `.\mvnw.cmd spring-boot:run` (`lab/backend`) |
| Frontend | Node.js | `npm install` then `npm start` (`lab/frontend`) |
| Frontend | Docker | `docker compose up --build` (`lab/frontend`); it reaches the backend through `host.docker.internal:8080` |
| Both | Docker | `docker compose up --build` (`lab`) |

Stop Docker with Ctrl+C, then `docker compose down` in the same folder. The Docker frontend has no live reload and no unit tests; use Node.js for those.

### Install once (Windows and Mac)

| Tool | Version | Check with |
|---|---|---|
| Java JDK | 17 or newer (e.g. Eclipse Temurin 17) | `java -version` |
| Node.js | 20 LTS (18.13+ also works) | `node -v` |
| Chrome | any recent | needed for `npm test` |

You do not need to install Maven. `mvnw` downloads it the first time.

On Windows, tick "Set JAVA_HOME" in the Temurin installer.

### Start the app

Open two terminals in the `lab` folder.

**Terminal 1: backend** on http://localhost:8080

```bash
cd backend

# Mac / Linux
./mvnw spring-boot:run

# Windows (PowerShell or CMD)
.\mvnw.cmd spring-boot:run
```

Wait for `Started BankLabApplication`.

**Terminal 2: frontend** on http://localhost:4200 (same on Windows and Mac)

```bash
cd frontend
npm install
npm start
```

Open http://localhost:4200 and log in as `andi` / `Password123!`.

The frontend sends `/api` calls to the backend through `proxy.conf.json`. Stop either app with Ctrl+C.

### If something goes wrong

| Problem | Fix |
|---|---|
| Mac: `permission denied: ./mvnw` | `chmod +x mvnw` |
| `JAVA_HOME is not set` or the wrong Java version | Install JDK 17 and set `JAVA_HOME` to its folder, then open a new terminal |
| Port 8080 or 4200 already in use | Stop the other app, or run `npm start -- --port 4300` for the frontend |
| `mvnw` or `npm install` cannot download | Office network/proxy: set the company Maven mirror in `~/.m2/settings.xml` and run `npm config set registry <company npm mirror>` |
| `npm test` cannot find Chrome | Set `CHROME_BIN` to the Chrome (or Edge) executable path |

The database resets every time the backend starts. To look inside it, open http://localhost:8080/h2-console with JDBC URL `jdbc:h2:mem:banklab`, user `sa` and an empty password.

## Demo users

All users have the password `Password123!`.

| User ID | Name | Accounts |
|---|---|---|
| `andi` | Andi Wijaya | `1234567890` (savings, Rp75.000.000), `1234567891` (current, Rp5.250.000) |
| `budi` | Budi Santoso | `2345678901` (savings, Rp12.500.000) |
| `citra` | Citra Lestari | `3456789012` (savings, Rp3.000.000) |

Beneficiaries at other banks (for inquiry and transfer):

| Bank | Code | Account | Name |
|---|---|---|---|
| BRI | `002` | `0011223344` | Dewi Anggraini |
| Bank Mandiri | `008` | `1370012345678` | Eko Prasetyo |
| BNI | `009` | `0456789123` | Fajar Nugroho |

Lab Bank's own code is `999`.

## API

Every call except login needs `Authorization: Bearer <token>`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{ "username", "password" }` → `{ token, username, fullName }` |
| GET | `/api/accounts?owner=<full name>` | Accounts of an owner |
| GET | `/api/accounts/{accountNo}` | One account |
| GET | `/api/accounts/{accountNo}/summary` | Balance and today's limit usage |
| POST | `/api/transfers/inquiry` | `{ "bankCode", "accountNo" }` → beneficiary name |
| POST | `/api/transfers` | `{ fromAccount, toBankCode, toAccount, amount, note }`, optional `Idempotency-Key` header → 201 |
| GET | `/api/transfers` | Your transfer history |

Errors look like `{ "errorCode": "LIMIT_EXCEEDED", "message": "Amount exceeds daily limit" }`. A call without a token gets 401 with an empty body.

## Commands

| Task | Command |
|---|---|
| Backend tests | `./mvnw test` |
| One backend test | `./mvnw test -Dtest=TransferServiceTest` |
| Backend coverage | after `./mvnw test`, open `target/site/jacoco/index.html` |
| Frontend tests | `npm test -- --watch=false` |
| Frontend build | `npm run build` |
| Dependency check | `npm audit` |
| Postman | Import both files in `postman/`, pick the `sit` environment, then run the collection (or the `smoke` folder) in the Collection Runner |

## Screens and test object IDs

Every element that Katalon needs has a stable `id`.

| Screen | IDs |
|---|---|
| Top menu | `menu_dashboard`, `menu_transfer`, `menu_history`, `lbl_userName`, `btn_logout` |
| Login `/login` | `txt_userId`, `txt_password`, `btn_login`, `lbl_loginError` |
| Dashboard `/dashboard` | `lbl_balance_<accountNo>`, `btn_newTransfer` |
| Transfer form `/transfer` | `sel_fromAccount`, `lbl_remainingLimit`, `sel_bank`, `txt_toAccount`, `err_toAccount`, `txt_amount`, `err_amount`, `txt_note`, `btn_submit`, `lbl_error` |
| Confirm | `lbl_beneficiaryName`, `lbl_confirmFrom`, `lbl_confirmTo`, `lbl_confirmAmount`, `lbl_confirmNote`, `btn_back`, `btn_confirm`, `lbl_error` |
| Receipt | `lbl_success`, `lbl_reference`, `lbl_status`, `lbl_receiptTo`, `lbl_receiptAmount`, `lbl_receiptNote`, `lbl_balanceAfter`, `btn_toDashboard`, `btn_newTransfer` |
| History `/history` | `tbl_history`, `lbl_empty`, `lbl_error` |

## Main code

| Backend (`com.example.banklab`) | Frontend (`src/app`) |
|---|---|
| `auth/AuthController`, `AuthFilter`, `TokenUtil` | `core/auth.service.ts`, `auth.guard.ts`, `auth.interceptor.ts` |
| `account/AccountService`, `AccountController`, `AccountRepository` | `core/account.service.ts`, `core/balance-store.service.ts` |
| `transfer/TransferService`, `TransferController`, `DailyLimitExceededException` | `core/transfer.service.ts`, `pages/transfer/transfer-form.component.ts`, `transfer-page.component.ts` |
| `common/GlobalExceptionHandler` | `pages/login`, `pages/dashboard`, `pages/history`, `shared/` pipes |
| `resources/db/migration` (schema and seed data) | |

This is a training sample with made-up data. It is not production code.
