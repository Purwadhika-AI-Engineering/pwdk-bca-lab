import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';

import { maskAccountNo } from '../../core/account.service';
import { TransferResponse } from '../../core/models';
import { TransferService } from '../../core/transfer.service';
import { RupiahPipe } from '../../shared/rupiah.pipe';

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [CommonModule, RupiahPipe],
  template: `
    <section class="card">
      <h1>Transfer history</h1>
      <p class="error" id="lbl_error" *ngIf="error">{{ error }}</p>
      <p *ngIf="!error && !rows.length" id="lbl_empty">No transfers yet.</p>

      <table class="table" id="tbl_history" *ngIf="rows.length">
        <thead>
          <tr>
            <th>Date</th><th>Reference</th><th>From</th><th>To</th>
            <th class="num">Amount</th><th>Status</th><th>Note</th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let t of rows">
            <td>{{ t.createdAt | date: 'dd MMM yyyy HH:mm' }}</td>
            <td>{{ t.referenceNo }}</td>
            <td>{{ mask(t.fromAccount) }}</td>
            <td>{{ t.toName }} · {{ t.toBankName }}</td>
            <td class="num">{{ t.amount | rupiah }}</td>
            <td>{{ t.status }}</td>
            <td>{{ t.note }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  `,
})
export class HistoryComponent implements OnInit {
  rows: TransferResponse[] = [];
  error = '';

  constructor(private transferService: TransferService) {}

  ngOnInit(): void {
    this.transferService.history().subscribe({
      next: (rows) => (this.rows = rows),
      error: (e: Error) => (this.error = e.message),
    });
  }

  mask(accountNo: string): string {
    return maskAccountNo(accountNo);
  }
}
