# Lab Bank team rules

Dummy rules sheet for the training labs. Lab Bank is a made-up bank, and these are not the rules of any real bank.

Use this file as the source for your steering files:

| Section | Goes into | Lab |
|---|---|---|
| 1–4 | `AGENTS.md` | Session 1, Lab 1 |
| 5 | `.kiro/steering/testing-unit-patterns.md` | Session 1, Lab 1 |
| 6 | `.kiro/steering/security-compliance.md` | Session 3 |

## 1. Commands

| Task | Command (folder) |
|---|---|
| Run backend | `./mvnw spring-boot:run` (`backend`) |
| All backend tests | `./mvnw test` (`backend`) |
| One backend test | `./mvnw test -Dtest=TransferServiceTest` (`backend`) |
| Frontend tests | `npm test -- --watch=false` (`frontend`) |
| Frontend build | `npm run build` (`frontend`) |

## 2. Money

- MUST use `BigDecimal` for money, scale 2, rounding `HALF_EVEN`. Why: `double` loses cents, and `HALF_UP` adds up in the bank's favor over many transfers (PRD R11).
- MUST return all API amounts in rupiah, never in cents (PRD R11).
- MUST keep debit and credit in one transaction (`@Transactional`). Why: if one fails, neither may be saved (PRD R9).

## 3. Personal data (PII) and logging

- MUST NOT write account numbers or NIK to logs in clear text. Mask them: `******7890` (PRD R12).
- MUST NOT log passwords, tokens or full request bodies.
- MUST mask account numbers on screen (PRD R12).

## 4. Code changes

- MUST NOT add a new Maven or npm dependency without approval in the pull request.
- MUST NOT edit files in `backend/src/main/resources/db/migration`. Add a new migration file instead.
- MUST follow the existing package layout: `account`, `auth`, `transfer`, `common` (backend) and `core`, `pages`, `shared` (frontend).
- MUST return errors as `{ "errorCode", "message" }` with the codes in `docs/PRD.md`.
- MUST NOT change or remove a test assertion (unit, Postman or Katalon) to make a failing test pass. Find the cause first, or ask. Why: a weakened test hides the bug.

## 5. Unit tests

- Java: JUnit 5, Mockito and AssertJ. MUST NOT use `@SpringBootTest` for service tests.
- Java controller tests: `@WebMvcTest` with `MockMvc`.
- Angular: Jasmine and Karma, `TestBed`.
- Angular HTTP tests: `provideHttpClient()` + `provideHttpClientTesting()` with `HttpTestingController`. MUST NOT use `HttpClientTestingModule` (deprecated in Angular 17). Call `http.verify()` in `afterEach`.
- Angular guards: call them with `TestBed.runInInjectionContext`. Mock services with `useValue`. No `any`.
- One behavior per test. Name the test by behavior, for example `rejectsAmountAboveDailyLimit`.
- MUST put the case ID from `docs/test-cases.md` in the test name: `@DisplayName("T5 Amount above daily limit (R4)")` in Java, `it('T5 …')` in Angular. Why: each test traces back to a case and a PRD rule.
- MUST cover limits and errors, not only the happy path: minimum Rp10.000, daily limit Rp50.000.000, cut-off 15.00 WIB.
- MUST use a fixed `Clock` (zone `Asia/Jakarta`) for time rules. Never `now()`, random data or test order.
- MUST assert real values. "Not null" alone is not a test.
- MUST NOT mock the class under test, and MUST NOT copy the production formula to compute the expected value.
- MUST use synthetic test data only, such as the demo users in `README.md`.
- MUST NOT change production code just to make a test pass. Report it instead.

## 6. Security

- MUST check that the account belongs to the logged-in user on every account and transfer endpoint. Otherwise return 403 (PRD R2).
- MUST use parameterized queries. MUST NOT build SQL by joining strings.
- MUST NOT return stack traces or raw exception messages to the client.
- MUST NOT put secrets (keys, passwords, tokens) in code or `application.properties`. Read them from environment variables.
- MUST hash passwords with a salted, slow hash (bcrypt or Argon2), never plain SHA-256 or MD5.
- MUST show user text (such as the transfer note) as plain text. MUST NOT use `innerHTML` or `bypassSecurityTrust*` for it (PRD R13).
- MUST NOT add a package with a known high or critical `npm audit` finding.
