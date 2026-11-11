import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

import { InquiryResponse, TransferDraft, TransferResponse } from './models';

const MESSAGES: Record<string, string> = {
  LIMIT_EXCEEDED: 'Amount exceeds daily limit',
  BELOW_MINIMUM: 'Minimum transfer is Rp10.000',
  INSUFFICIENT_FUNDS: 'Insufficient balance',
  SAME_ACCOUNT: 'Source and target account must be different',
  ACCOUNT_NOT_FOUND: 'Account not found',
  FORBIDDEN: 'You cannot use this account',
};

@Injectable({ providedIn: 'root' })
export class TransferService {
  constructor(private http: HttpClient) {}

  inquiry(bankCode: string, accountNo: string): Observable<InquiryResponse> {
    return this.http
      .post<InquiryResponse>('/api/transfers/inquiry', { bankCode, accountNo })
      .pipe(catchError(toFriendlyError));
  }

  submit(draft: TransferDraft, idempotencyKey: string): Observable<TransferResponse> {
    return this.http
      .post<TransferResponse>('/api/transfers', draft, {
        headers: { 'Idempotency-Key': idempotencyKey },
      })
      .pipe(catchError(toFriendlyError));
  }

  history(): Observable<TransferResponse[]> {
    return this.http.get<TransferResponse[]>('/api/transfers').pipe(catchError(toFriendlyError));
  }
}

function toFriendlyError(err: HttpErrorResponse) {
  const code = err.error?.errorCode;
  const message = (code && MESSAGES[code]) || 'Something went wrong. Please try again.';
  return throwError(() => new Error(message));
}
