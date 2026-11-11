import { Injectable } from '@angular/core';

/**
 * Keeps the latest known balance per account, so the dashboard
 * does not need to call the API again right after a transfer.
 */
@Injectable({ providedIn: 'root' })
export class BalanceStore {
  private balances = new Map<string, number>();

  set(accountNo: string, balance: number): void {
    this.balances.set(accountNo, balance);
  }

  get(accountNo: string): number | undefined {
    return this.balances.get(accountNo);
  }

  clear(): void {
    this.balances.clear();
  }
}
