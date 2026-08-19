import type { Meta, StoryObj } from '@storybook/react-vite';
import { Mail, Search } from 'lucide-react';
import { InputGroup, InputGroupAddon, InputGroupInput } from '.';

/**
 * `InputGroup` is the composition wrapper that gives a bare `Input` its bordered
 * box, label, error text, and addon (icon / text / button) slots. It shares
 * focus and error state with its children via context. Compose it from
 * `InputGroupAddon` (icons/buttons) and `InputGroupInput` (the field).
 */
const meta = {
  title: 'Components/InputGroup',
  component: InputGroup,
  tags: ['autodocs'],
  args: {
    size: 'md',
    variant: 'outline',
    isInvalid: false,
  },
  argTypes: {
    size: {
      control: 'select',
      options: ['xs', 'sm', 'md', 'lg', 'xl'],
    },
    variant: {
      control: 'select',
      options: ['outline'],
    },
    label: { control: 'text' },
    errorText: { control: 'text' },
    children: { control: false },
    ref: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof InputGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { label: 'Email', inputId: 'group-default' },
  render: (args) => (
    <div className="w-72">
      <InputGroup {...args}>
        <InputGroupInput placeholder="you@example.com" type="email" />
      </InputGroup>
    </div>
  ),
};

export const WithLeadingIcon: Story = {
  args: { label: 'Email', inputId: 'group-leading' },
  render: (args) => (
    <div className="w-72">
      <InputGroup {...args}>
        <InputGroupAddon align="inline-start">
          <Mail aria-hidden />
        </InputGroupAddon>
        <InputGroupInput placeholder="you@example.com" type="email" />
      </InputGroup>
    </div>
  ),
};

export const WithBothIcons: Story = {
  args: { inputId: 'group-both' },
  render: (args) => (
    <div className="w-72">
      <InputGroup {...args}>
        <InputGroupAddon align="inline-start">
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput placeholder="Search..." type="search" />
        <InputGroupAddon align="inline-end">
          <span className="text-ink-inactive text-xs">⌘K</span>
        </InputGroupAddon>
      </InputGroup>
    </div>
  ),
};

export const ErrorState: Story = {
  args: {
    label: 'Email',
    inputId: 'group-error',
    isInvalid: true,
    errorText: 'Enter a valid email address.',
  },
  render: (args) => (
    <div className="w-72">
      <InputGroup {...args}>
        <InputGroupAddon align="inline-start">
          <Mail aria-hidden />
        </InputGroupAddon>
        <InputGroupInput placeholder="you@example.com" type="email" />
      </InputGroup>
    </div>
  ),
};

export const Disabled: Story = {
  args: { label: 'Email', inputId: 'group-disabled' },
  render: (args) => (
    <div className="w-72">
      <InputGroup {...args}>
        <InputGroupAddon align="inline-start">
          <Mail aria-hidden />
        </InputGroupAddon>
        <InputGroupInput disabled defaultValue="disabled@example.com" />
      </InputGroup>
    </div>
  ),
};

export const Sizes: Story = {
  render: (args) => {
    const sizes = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
    return (
      <div className="flex w-72 flex-col gap-4">
        {sizes.map((size) => (
          <InputGroup
            {...args}
            key={size}
            size={size}
            label={size}
            inputId={`group-${size}`}
          >
            <InputGroupAddon align="inline-start">
              <Mail aria-hidden />
            </InputGroupAddon>
            <InputGroupInput placeholder="you@example.com" />
          </InputGroup>
        ))}
      </div>
    );
  },
};
