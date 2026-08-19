import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { fn } from 'storybook/test';
import { Calendar } from './Calendar';
import { DateRangePicker } from './DateRangePicker';
import { SingleDatePicker } from './SingleDatePicker';

// SingleDatePicker is the primary story component: a full picker with calendar,
// month/year controls and a confirm button, driven by controlled `selected`.
const meta = {
  title: 'Components/Datepicker',
  component: SingleDatePicker,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: {
    confirmLabel: 'Set date',
    onSelect: fn(),
    onConfirm: fn(),
  },
  argTypes: {
    selected: { control: false },
    startMonth: { control: false },
    endMonth: { control: false },
    className: { control: false },
    onSelect: { control: false, table: { disable: true } },
    onConfirm: { control: false, table: { disable: true } },
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SingleDatePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {
  render: (args) => {
    const [date, setDate] = useState<Date | undefined>(new Date());
    return (
      <SingleDatePicker
        {...args}
        selected={date}
        onSelect={(next) => {
          setDate(next);
          args.onSelect?.(next);
        }}
      />
    );
  },
};

// DateRangePicker renders side-by-side months and selects a { from, to } range.
export const Range: StoryObj<typeof DateRangePicker> = {
  render: () => {
    const today = new Date();
    const [range, setRange] = useState<DateRange | undefined>({
      from: today,
      to: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 5),
    });
    return (
      <div className="w-[36rem] max-w-full">
        <DateRangePicker
          selected={range}
          confirmLabel="Set range"
          onSelect={setRange}
          onConfirm={fn()}
        />
      </div>
    );
  },
};

// The underlying Calendar (react-day-picker) in single mode with disabled dates.
// `mode` is fixed here because react-day-picker types `selected`/`onSelect`
// against the mode discriminant, so a single control cannot switch it safely;
// `captionLayout` and `showOutsideDays` are the live controls.
export const CalendarSingle: StoryObj<typeof Calendar> = {
  argTypes: {
    captionLayout: {
      control: 'select',
      options: ['label', 'dropdown', 'dropdown-months', 'dropdown-years'],
    },
    showOutsideDays: { control: 'boolean' },
  },
  args: {
    captionLayout: 'dropdown',
    showOutsideDays: true,
  },
  render: (args) => {
    const [selected, setSelected] = useState<Date | undefined>(new Date());
    return (
      <div className="rounded-md border border-stroke bg-surface-card">
        <Calendar
          {...args}
          mode="single"
          selected={selected}
          onSelect={setSelected}
          // Disable weekends to demo the `disabled` matcher.
          disabled={(day: Date) => day.getDay() === 0 || day.getDay() === 6}
        />
      </div>
    );
  },
};
