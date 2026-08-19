import type { Meta, StoryObj } from '@storybook/react-vite';
import { SearchX } from 'lucide-react';
import { fn } from 'storybook/test';
import { Button } from '../Button';
import { StatusView } from '.';

const meta = {
  title: 'Components/StatusView',
  component: StatusView,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  args: {
    tone: 'neutral',
    size: 'md',
    surface: 'standalone',
    actionsOrientation: 'inline',
    title: 'No chats yet',
    description: 'Start a new conversation to see it appear here.',
    onRetry: fn(),
  },
  argTypes: {
    tone: {
      control: 'select',
      options: ['neutral', 'error', 'info', 'success'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    surface: {
      control: 'select',
      options: ['embedded', 'standalone'],
    },
    actionsOrientation: {
      control: 'select',
      options: ['inline', 'stacked'],
    },
    title: { control: 'text' },
    description: { control: 'text' },
    retryLabel: { control: 'text' },
    icon: { control: false },
    actions: { control: false },
    onRetry: { control: false },
    ref: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof StatusView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {};

export const ErrorState: Story = {
  args: {
    tone: 'error',
    title: 'Something went wrong',
    description: 'We could not load your data. Please try again.',
    retryLabel: 'Retry',
  },
};

export const Info: Story = {
  args: {
    tone: 'info',
    title: 'Sync in progress',
    description: 'Your connectors are being indexed in the background.',
  },
};

export const Success: Story = {
  args: {
    tone: 'success',
    title: 'All set',
    description: 'Your workspace has been configured successfully.',
  },
};

export const WithCustomIcon: Story = {
  args: {
    title: 'No results found',
    description: 'Try adjusting your search or filters.',
    icon: <SearchX aria-hidden="true" />,
  },
};

export const WithAction: Story = {
  args: {
    title: 'No chats yet',
    description: 'Start a new conversation to see it appear here.',
    actions: (
      <Button variant="primary" size="sm" rounded="full">
        New chat
      </Button>
    ),
  },
};
