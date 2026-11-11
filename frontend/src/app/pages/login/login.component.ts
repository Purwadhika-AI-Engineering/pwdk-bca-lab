import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';

import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <section class="card narrow">
      <h1>Sign in</h1>
      <form [formGroup]="form" (ngSubmit)="submit()">
        <label for="txt_userId">User ID</label>
        <input id="txt_userId" formControlName="userId" autocomplete="username" />

        <label for="txt_password">Password</label>
        <input id="txt_password" type="password" formControlName="password" autocomplete="current-password" />

        <p id="lbl_loginError" class="error" *ngIf="error">{{ error }}</p>

        <button id="btn_login" type="submit" [disabled]="form.invalid || loading">Login</button>
      </form>
      <p class="hint">Demo users: andi, budi, citra · password: Password123!</p>
    </section>
  `,
})
export class LoginComponent {
  form = this.fb.nonNullable.group({
    userId: ['', Validators.required],
    password: ['', Validators.required],
  });
  error = '';
  loading = false;

  constructor(private fb: FormBuilder, private auth: AuthService, private router: Router) {}

  submit(): void {
    if (this.form.invalid) {
      return;
    }
    this.loading = true;
    this.error = '';
    const { userId, password } = this.form.getRawValue();
    this.auth.login(userId, password).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: () => {
        this.error = 'Invalid user ID or password';
        this.loading = false;
      },
    });
  }
}
