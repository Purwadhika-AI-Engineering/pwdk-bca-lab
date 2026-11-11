import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { sortBy } from 'lodash';

import { AccountService, maskAccountNo } from '../../core/account.service';
import { AuthService } from '../../core/auth.service';
import { BalanceStore } from '../../core/balance-store.service';
import { AccountView } from '../../core/models';
import { RupiahPipe } from '../../shared/rupiah.pipe';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink, RupiahPipe],
  template: `
    <section class="card">
      <h1>Hello, {{ fullName }}</h1>
      <p class="error" id="lbl_error" *ngIf="error">{{ error }}</p>

      <table class="table" *ngIf="accounts.length">
        <thead>
          <tr><th>Account</th><th>Type</th><th class="num">Balance</th></tr>
        </thead>
        <tbody>
          <tr *ngFor="let a of accounts">
            <td>{{ mask(a.accountNo) }}</td>
            <td>{{ a.accountType }}</td>
            <td class="num" [id]="'lbl_balance_' + a.accountNo">{{ balanceOf(a) | rupiah }}</td>
          </tr>
        </tbody>
      </table>

      <a class="button" routerLink="/transfer" id="btn_newTransfer">New transfer</a>
    </section>
  `,
})
export class DashboardComponent implements OnInit {
  fullName = '';
  accounts: AccountView[] = [];
  error = '';

  constructor(
    private auth: AuthService,
    private accountService: AccountService,
    private balances: BalanceStore,
  ) {}

  ngOnInit(): void {
    const user = this.auth.currentUser();
    this.fullName = user?.fullName ?? '';
    this.accountService.getMyAccounts(this.fullName).subscribe({
      next: (accounts) => (this.accounts = sortBy(accounts, 'accountType').reverse()),
      error: (e: Error) => (this.error = e.message),
    });
  }

  // use the balance from the last transfer when we have it, to save an API call
  balanceOf(a: AccountView): number {
    return this.balances.get(a.accountNo) ?? a.balance;
  }

  mask(accountNo: string): string {
    return maskAccountNo(accountNo);
  }
}
