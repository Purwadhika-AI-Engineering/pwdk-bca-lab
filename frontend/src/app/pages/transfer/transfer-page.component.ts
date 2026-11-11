import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AccountService, maskAccountNo } from '../../core/account.service';
import { AuthService } from '../../core/auth.service';
import { BalanceStore } from '../../core/balance-store.service';
import { AccountView, InquiryResponse, TransferDraft, TransferResponse } from '../../core/models';
import { TransferService } from '../../core/transfer.service';
import { RupiahPipe } from '../../shared/rupiah.pipe';
import { SafeHtmlPipe } from '../../shared/safe-html.pipe';
import { TransferFormComponent } from './transfer-form.component';

type Step = 'form' | 'confirm' | 'receipt';

@Component({
  selector: 'app-transfer-page',
  standalone: true,
  imports: [CommonModule, RouterLink, RupiahPipe, SafeHtmlPipe, TransferFormComponent],
  template: `
    <section class="card narrow">
      <h1>Transfer</h1>
      <ol class="steps">
        <li [class.active]="step === 'form'">Details</li>
        <li [class.active]="step === 'confirm'">Confirm</li>
        <li [class.active]="step === 'receipt'">Receipt</li>
      </ol>

      <app-transfer-form
        *ngIf="step === 'form'"
        [accounts]="accounts"
        [remainingLimit]="remainingLimit"
        [serverError]="error"
        [busy]="busy"
        (fromAccountChange)="loadLimit($event)"
        (submitTransfer)="checkBeneficiary($event)"
      ></app-transfer-form>

      <div *ngIf="step === 'confirm' && draft && beneficiary">
        <dl class="details">
          <dt>From</dt><dd id="lbl_confirmFrom">{{ mask(draft.fromAccount) }}</dd>
          <dt>To</dt>
          <dd id="lbl_beneficiaryName">{{ beneficiary.accountName }}</dd>
          <dt>Bank / account</dt>
          <dd id="lbl_confirmTo">{{ beneficiary.bankName }} · {{ beneficiary.accountNo }}</dd>
          <dt>Amount</dt><dd id="lbl_confirmAmount">{{ draft.amount | rupiah }}</dd>
          <dt>Note</dt><dd id="lbl_confirmNote">{{ draft.note || '-' }}</dd>
        </dl>
        <p class="error" id="lbl_error" *ngIf="error">{{ error }}</p>
        <div class="row">
          <button id="btn_back" type="button" class="secondary" (click)="back()" [disabled]="busy">Back</button>
          <button id="btn_confirm" type="button" (click)="confirm()" [disabled]="busy">Confirm transfer</button>
        </div>
      </div>

      <div *ngIf="step === 'receipt' && receipt">
        <p class="success" id="lbl_success">
          {{ receipt.status === 'PENDING' ? 'Transfer accepted. It will be sent on the next business day.' : 'Transfer successful' }}
        </p>
        <dl class="details">
          <dt>Reference no.</dt><dd id="lbl_reference">{{ receipt.referenceNo }}</dd>
          <dt>Status</dt><dd id="lbl_status">{{ receipt.status }}</dd>
          <dt>To</dt><dd id="lbl_receiptTo">{{ receipt.toName }} · {{ receipt.toBankName }}</dd>
          <dt>Amount</dt><dd id="lbl_receiptAmount">{{ receipt.amount | rupiah }}</dd>
          <dt>Note</dt><dd id="lbl_receiptNote" [innerHTML]="receipt.note | safeHtml"></dd>
          <dt>Balance after</dt><dd id="lbl_balanceAfter">{{ receipt.balanceAfter | rupiah }}</dd>
        </dl>
        <div class="row">
          <a class="button secondary" routerLink="/dashboard" id="btn_toDashboard">Back to dashboard</a>
          <button id="btn_newTransfer" type="button" (click)="reset()">New transfer</button>
        </div>
      </div>
    </section>
  `,
})
export class TransferPageComponent implements OnInit {
  step: Step = 'form';
  accounts: AccountView[] = [];
  remainingLimit: number | null = null;
  draft: TransferDraft | null = null;
  beneficiary: InquiryResponse | null = null;
  receipt: TransferResponse | null = null;
  error = '';
  busy = false;
  private idempotencyKey = '';

  constructor(
    private auth: AuthService,
    private accountService: AccountService,
    private transferService: TransferService,
    private balances: BalanceStore,
  ) {}

  ngOnInit(): void {
    const user = this.auth.currentUser();
    this.accountService.getMyAccounts(user?.fullName ?? '').subscribe({
      next: (accounts) => (this.accounts = accounts),
      error: (e: Error) => (this.error = e.message),
    });
  }

  loadLimit(accountNo: string): void {
    this.remainingLimit = null;
    if (!accountNo) {
      return;
    }
    this.accountService.getSummary(accountNo).subscribe({
      next: (s) => (this.remainingLimit = s.dailyLimitRemaining),
      error: () => (this.remainingLimit = null),
    });
  }

  checkBeneficiary(draft: TransferDraft): void {
    this.error = '';
    this.busy = true;
    this.transferService.inquiry(draft.toBankCode, draft.toAccount).subscribe({
      next: (b) => {
        this.draft = draft;
        this.beneficiary = b;
        this.idempotencyKey = crypto.randomUUID();
        this.step = 'confirm';
        this.busy = false;
      },
      error: (e: Error) => {
        this.error = e.message;
        this.busy = false;
      },
    });
  }

  confirm(): void {
    if (!this.draft) {
      return;
    }
    this.error = '';
    this.busy = true;
    this.transferService.submit(this.draft, this.idempotencyKey).subscribe({
      next: (r) => {
        this.receipt = r;
        if (r.balanceAfter != null) {
          this.balances.set(r.fromAccount, r.balanceAfter);
        }
        this.step = 'receipt';
        this.busy = false;
      },
      error: (e: Error) => {
        this.error = e.message;
        this.busy = false;
      },
    });
  }

  back(): void {
    this.error = '';
    this.step = 'form';
  }

  reset(): void {
    this.draft = null;
    this.beneficiary = null;
    this.receipt = null;
    this.error = '';
    this.step = 'form';
    if (this.accounts.length) {
      this.loadLimit(this.accounts[0].accountNo);
    }
  }

  mask(accountNo: string): string {
    return maskAccountNo(accountNo);
  }
}
