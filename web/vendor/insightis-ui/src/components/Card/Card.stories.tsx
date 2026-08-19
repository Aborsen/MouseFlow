import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '.';

const meta = {
  title: 'Components/Card',
  component: Card,
  tags: ['autodocs'],
  args: {
    variant: 'outline',
    rounded: 'lg',
    fullWidth: false,
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['secondary', 'outline'],
    },
    rounded: {
      control: 'select',
      options: ['none', 'sm', 'md', 'lg', 'xl'],
    },
    children: { control: false },
    ref: { control: false, table: { disable: true } },
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Card {...args} className="w-80">
      <CardHeader>
        <CardTitle>Usage this month</CardTitle>
        <CardDescription>Resets on the 1st of each month.</CardDescription>
      </CardHeader>
      <CardContent>
        You have used 640 of 1,000 messages included in your plan.
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="secondary" size="sm">
          View details
        </Button>
        <Button size="sm">Upgrade</Button>
      </CardFooter>
    </Card>
  ),
};

export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-start gap-4">
      <Card {...args} variant="outline" className="w-72">
        <CardHeader>
          <CardTitle>Outline</CardTitle>
          <CardDescription>
            Bordered surface with a subtle shadow.
          </CardDescription>
        </CardHeader>
        <CardContent>Default variant, best for standalone content.</CardContent>
      </Card>
      <Card {...args} variant="secondary" className="w-72">
        <CardHeader>
          <CardTitle>Secondary</CardTitle>
          <CardDescription>Filled surface with hover feedback.</CardDescription>
        </CardHeader>
        <CardContent>Best for interactive list rows and tiles.</CardContent>
      </Card>
    </div>
  ),
};

export const Rounded: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-start gap-4">
      {(['none', 'sm', 'md', 'lg', 'xl'] as const).map((rounded) => (
        <Card {...args} key={rounded} rounded={rounded} className="w-40">
          <CardHeader>
            <CardTitle>{rounded}</CardTitle>
          </CardHeader>
          <CardContent>Corner rounding: {rounded}.</CardContent>
        </Card>
      ))}
    </div>
  ),
};

export const FullWidth: Story = {
  args: { fullWidth: true },
  parameters: { layout: 'padded' },
  render: (args) => (
    <Card {...args}>
      <CardHeader>
        <CardTitle>Full-width card</CardTitle>
        <CardDescription>Stretches to fill its container.</CardDescription>
      </CardHeader>
      <CardContent>
        Useful inside page sections and settings panels.
      </CardContent>
    </Card>
  ),
};
