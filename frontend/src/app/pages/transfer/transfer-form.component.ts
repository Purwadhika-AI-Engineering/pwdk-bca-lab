import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { maskAccountNo } from '../../core/account.service';
import { AccountView, BANKS, TransferDraft } from '../../core/models';
import { RupiahPipe } from '../../shared/rupiah.pipe';

@Component({
  selector: 'app-transfer-form',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RupiahPipe],
  template: `
    <form [formGroup]="form" (ngSubmit)="submit()">
      <label for="sel_fromAccount">From account</label>
      <select id="sel_fromAccount" formControlName="fromAccount" (change)="onFromChange()">
        <option *ngFor="let a of accounts" [value]="a.accountNo">
          {{ mask(a.accountNo) }} · {{ a.accountType }}
        </option>
      </select>
      <p class="hint" id="lbl_remainingLimit" *ngIf="remainingLimit != null">
        Remaining limit today: {{ remainingLimit | rupiah }}
      </p>

      <label for="sel_bank">Bank</label>
      <select id="sel_bank" formControlName="toBankCode">
        <option *ngFor="let b of banks" [value]="b.code">{{ b.name }}</option>
      </select>

      <label for="txt_toAccount">To account</label>
      <input id="txt_toAccount" formControlName="toAccount" inputmode="numeric" />
      <p class="field-error" id="err_toAccount" *ngIf="showError('toAccount')">
        Enter a 10 to 13 digit account number
      </p>

      <label for="txt_amount">Amount (Rp)</label>
      <input id="txt_amount" type="number" formControlName="amount" />
      <p class="field-error" id="err_amount" *ngIf="showError('amount')">
        Minimum transfer is Rp10.000
      </p>

      <label for="txt_note">Note (optional)</label>
      <input id="txt_note" formControlName="note" maxlength="100" />

      <p class="error" id="lbl_error" *ngIf="error || serverError">{{ error || serverError }}</p>

      <button id="btn_submit" type="submit" [disabled]="form.invalid || busy">Continue</button>
    </form>
  `,
})
export class TransferFormComponent implements OnChanges {
  @Input() accounts: AccountView[] = [];
  @Input() remainingLimit: number | null = null;
  @Input() serverError = '';
  @Input() busy = false;
  @Output() submitTransfer = new EventEmitter<TransferDraft>();
  @Output() fromAccountChange = new EventEmitter<string>();

  banks = BANKS;
  error = '';

  form = this.fb.nonNullable.group({
    fromAccount: ['', Validators.required],
    toBankCode: ['999', Validators.required],
    toAccount: ['', [Validators.required, Validators.pattern(/^\d{10,13}$/)]],
    amount: [null as number | null, [Validators.required, Validators.min(10000)]],
    note: [''],
  });

  constructor(private fb: FormBuilder) {}

  ngOnChanges(): void {
    if (!this.form.controls.fromAccount.value && this.accounts.length) {
      this.form.controls.fromAccount.setValue(this.accounts[0].accountNo);
      this.onFromChange();
    }
  }

  onFromChange(): void {
    this.fromAccountChange.emit(this.form.controls.fromAccount.value);
  }

  showError(name: 'toAccount' | 'amount'): boolean {
    const c = this.form.controls[name];
    return c.invalid && (c.dirty || c.touched);
  }

  submit(): void {
    this.error = '';
    if (this.form.invalid) {
      return;
    }
    const value = this.form.getRawValue();
    if (this.remainingLimit != null && Number(value.amount) > this.remainingLimit) {
      this.error = 'Amount exceeds daily limit';
      return;
    }
    this.submitTransfer.emit({
      fromAccount: value.fromAccount,
      toBankCode: value.toBankCode,
      toAccount: value.toAccount,
      amount: Number(value.amount),
      note: value.note,
    });
  }

  mask(accountNo: string): string {
    return maskAccountNo(accountNo);
  }
}
