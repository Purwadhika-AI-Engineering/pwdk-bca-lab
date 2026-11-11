import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

import { AccountSummary, AccountView } from './models';

@Injectable({ providedIn: 'root' })
export class AccountService {
  constructor(private http: HttpClient) {}

  getMyAccounts(ownerName: string): Observable<AccountView[]> {
    return this.http
      .get<AccountView[]>('/api/accounts?owner=' + ownerName)
      .pipe(catchError(() => throwError(() => new Error('Cannot load accounts. Please try again.'))));
  }

  getSummary(accountNo: string): Observable<AccountSummary> {
    return this.http.get<AccountSummary>(`/api/accounts/${accountNo}/summary`).pipe(
      map((s) => ({ ...s, maskedNo: maskAccountNo(s.accountNo) })),
      catchError(() => throwError(() => new Error('Cannot load account summary. Please try again.'))),
    );
  }
}

export function maskAccountNo(accountNo: string): string {
  if (!accountNo || accountNo.length <= 4) {
    return accountNo;
  }
  return '*'.repeat(accountNo.length - 4) + accountNo.slice(-4);
}
