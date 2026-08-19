import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { Pagination } from '.';

const meta = {
  title: 'Components/Pagination',
  component: Pagination,
  tags: ['autodocs'],
  args: {
    currentPage: 5,
    totalPages: 10,
    siblingCount: 1,
    boundaryCount: 1,
    showFirstLast: true,
    showPrevNext: true,
    onPageChange: fn(),
  },
  argTypes: {
    currentPage: { control: { type: 'number', min: 1 } },
    totalPages: { control: { type: 'number', min: 1 } },
    siblingCount: { control: { type: 'number', min: 0 } },
    boundaryCount: { control: { type: 'number', min: 0 } },
    showFirstLast: { control: 'boolean' },
    showPrevNext: { control: 'boolean' },
    onPageChange: { control: false },
  },
} satisfies Meta<typeof Pagination>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const FirstPage: Story = {
  args: { currentPage: 1 },
};

export const LastPage: Story = {
  args: { currentPage: 10 },
};

export const FewPages: Story = {
  args: { currentPage: 2, totalPages: 4 },
};

export const Interactive: Story = {
  render: (args) => {
    const [page, setPage] = useState(args.currentPage);
    return (
      <Pagination
        {...args}
        currentPage={page}
        onPageChange={(next) => {
          setPage(next);
          args.onPageChange(next);
        }}
      />
    );
  },
};
