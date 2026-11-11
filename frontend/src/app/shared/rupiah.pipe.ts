import { Pipe, PipeTransform } from '@angular/core';

const formatter = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

@Pipe({ name: 'rupiah', standalone: true })
export class RupiahPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return value == null ? '-' : formatter.format(value);
  }
}
