import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { Spinner } from '../Spinner';
import { Typography } from '../Typography';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '.';
import type { TableSortDirection } from './TableHead';

interface InvoiceRow {
  id: string;
  invoice: string;
  status: 'Paid' | 'Pending' | 'Overdue';
  method: string;
  amount: string;
}

const invoices: InvoiceRow[] = [
  {
    id: 'INV001',
    invoice: 'INV001',
    status: 'Paid',
    method: 'Credit Card',
    amount: '$250.00',
  },
  {
    id: 'INV002',
    invoice: 'INV002',
    status: 'Pending',
    method: 'PayPal',
    amount: '$150.00',
  },
  {
    id: 'INV003',
    invoice: 'INV003',
    status: 'Overdue',
    method: 'Bank Transfer',
    amount: '$350.00',
  },
  {
    id: 'INV004',
    invoice: 'INV004',
    status: 'Paid',
    method: 'Credit Card',
    amount: '$450.00',
  },
  {
    id: 'INV005',
    invoice: 'INV005',
    status: 'Paid',
    method: 'PayPal',
    amount: '$550.00',
  },
  {
    id: 'INV006',
    invoice: 'INV006',
    status: 'Pending',
    method: 'Bank Transfer',
    amount: '$200.00',
  },
];

const meta = {
  title: 'Components/Table',
  component: Table,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  argTypes: {
    wrapperClassName: { control: false },
    ref: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Table {...args}>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{row.invoice}</TableCell>
            <TableCell>{row.status}</TableCell>
            <TableCell>{row.method}</TableCell>
            <TableCell className="text-right">{row.amount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

export const WithFooterAndCaption: Story = {
  render: (args) => (
    <Table {...args}>
      <TableCaption>A list of your recent invoices.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{row.invoice}</TableCell>
            <TableCell>{row.status}</TableCell>
            <TableCell>{row.method}</TableCell>
            <TableCell className="text-right">{row.amount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3}>Total</TableCell>
          <TableCell className="text-right">$1,950.00</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};

// The selected/hover states live on body rows via `data-state=selected`.
export const SelectableRows: Story = {
  render: (args) => {
    const [selected, setSelected] = useState<string | null>('INV002');
    return (
      <Table {...args}>
        <TableHeader>
          <TableRow>
            <TableHead>Invoice</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Method</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((row) => (
            <TableRow
              key={row.id}
              data-state={selected === row.id ? 'selected' : undefined}
              className="cursor-pointer"
              onClick={() => setSelected(row.id)}
            >
              <TableCell className="font-medium">{row.invoice}</TableCell>
              <TableCell>{row.status}</TableCell>
              <TableCell>{row.method}</TableCell>
              <TableCell className="text-right">{row.amount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  },
};

// TableHead exposes `sortable`, `sortDirection` ('asc' | 'desc' | undefined) and `onSort`.
export const SortableHeader: Story = {
  render: (args) => {
    const [direction, setDirection] = useState<TableSortDirection>('asc');
    const onSort = fn(() =>
      setDirection((prev) =>
        prev === 'asc' ? 'desc' : prev === 'desc' ? undefined : 'asc'
      )
    );
    return (
      <Table {...args}>
        <TableHeader>
          <TableRow>
            <TableHead sortable sortDirection={direction} onSort={onSort}>
              Invoice
            </TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Method</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{row.invoice}</TableCell>
              <TableCell>{row.status}</TableCell>
              <TableCell>{row.method}</TableCell>
              <TableCell className="text-right">{row.amount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  },
};

export const Empty: Story = {
  render: (args) => (
    <Table {...args}>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell colSpan={4} className="h-24 text-center">
            <Typography textColor="secondary">No invoices found.</Typography>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

export const Loading: Story = {
  render: (args) => (
    <Table {...args}>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell colSpan={4} className="h-24 text-center">
            <div className="flex items-center justify-center gap-2">
              <Spinner size="sm" />
              <Typography textColor="secondary">Loading invoices…</Typography>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};
