import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="topbar">
      <span class="brand">Lab Bank</span>
      <nav *ngIf="auth.isLoggedIn()">
        <a id="menu_dashboard" routerLink="/dashboard" routerLinkActive="active">Dashboard</a>
        <a id="menu_transfer" routerLink="/transfer" routerLinkActive="active">Transfer</a>
        <a id="menu_history" routerLink="/history" routerLinkActive="active">History</a>
        <span class="user" id="lbl_userName">{{ auth.currentUser()?.fullName }}</span>
        <button id="btn_logout" type="button" class="link" (click)="logout()">Log out</button>
      </nav>
    </header>
    <main>
      <router-outlet></router-outlet>
    </main>
  `,
})
export class AppComponent {
  constructor(public auth: AuthService, private router: Router) {}

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
