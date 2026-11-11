import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, tap } from 'rxjs';

import { BalanceStore } from './balance-store.service';
import { LoginResponse } from './models';

const TOKEN_KEY = 'banklab_token';
const USER_KEY = 'banklab_user';

@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(private http: HttpClient, private balances: BalanceStore) {}

  login(username: string, password: string): Observable<LoginResponse> {
    return this.http
      .post<LoginResponse>('/api/auth/login', { username, password })
      .pipe(
        tap((res) => {
          localStorage.setItem(TOKEN_KEY, res.token);
          localStorage.setItem(
            USER_KEY,
            JSON.stringify({ username: res.username, fullName: res.fullName }),
          );
        }),
      );
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    this.balances.clear();
  }

  isLoggedIn(): boolean {
    return !!localStorage.getItem(TOKEN_KEY);
  }

  token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  currentUser(): { username: string; fullName: string } | null {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  }
}
