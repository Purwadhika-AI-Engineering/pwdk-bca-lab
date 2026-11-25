# Unit test patterns

Source: `docs/team-rules.md` section 5. Test cases: `docs/test-cases.md` (format in `templates/test-cases.md`). Product rules (R1–R14): `docs/PRD.md`.

## Frameworks

- Java: JUnit 5, Mockito and AssertJ. MUST NOT use `@SpringBootTest` for service tests.
- Java controller tests: `@WebMvcTest` with `MockMvc`.
- Angular: Jasmine and Karma, `TestBed`.
- Angular HTTP tests: `provideHttpClient()` + `provideHttpClientTesting()` with `HttpTestingController`. MUST NOT use `HttpClientTestingModule` (deprecated in Angular 17). Call `http.verify()` in `afterEach`.
- Angular guards: call them with `TestBed.runInInjectionContext`. Mock services with `useValue`. No `any`.

## Naming and traceability

- One behavior per test. Name the test by behavior, for example `rejectsAmountAboveDailyLimit`.
- MUST put the case ID from `docs/test-cases.md` in the test name: `@DisplayName("T5 Amount above daily limit (R4)")` in Java, `it('T5 …')` in Angular. Why: each test traces back to a case and a PRD rule.

## What to test

- MUST cover limits and errors, not only the happy path: minimum Rp10.000, daily limit Rp50.000.000, cut-off 15.00 WIB.
- MUST use a fixed `Clock` (zone `Asia/Jakarta`) for time rules. Never `now()`, random data or test order.
- MUST assert real values. "Not null" alone is not a test.
- MUST NOT mock the class under test, and MUST NOT copy the production formula to compute the expected value.
- MUST use synthetic test data only, such as the demo users in `README.md`.
- MUST NOT change production code just to make a test pass. Report it instead.

## Commands

| Task | Command (folder) |
|---|---|
| All backend tests | `./mvnw test` (`backend`), on Windows `.\mvnw.cmd test` |
| One backend test | `./mvnw test -Dtest=TransferServiceTest` (`backend`) |
| Backend coverage | after `./mvnw test`, open `backend/target/site/jacoco/index.html` |
| Frontend tests | `npm test -- --watch=false` (`frontend`) |
