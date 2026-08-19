import type { Meta, StoryObj } from '@storybook/react-vite';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../Button';
import { Typography } from '../Typography';
import { Stepper } from '.';
import type { StepperApi, StepRenderer } from './types';

const meta = {
  title: 'Components/Stepper',
  component: Stepper,
  tags: ['autodocs'],
  args: {
    initialStep: 0,
    onStepChange: undefined,
  },
  argTypes: {
    initialStep: {
      control: { type: 'range', min: 0, max: 2, step: 1 },
    },
    steps: { control: false },
    initialData: { control: false },
    onStepChange: { control: false },
    ref: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof Stepper>;

export default meta;
type Story = StoryObj<typeof meta>;

const STEP_LABELS = ['Account', 'Profile', 'Confirm'] as const;

// Shared step indicator that reads completed/active/upcoming state off the API.
function StepIndicator({
  api,
  orientation,
}: {
  api: StepperApi<unknown>;
  orientation: 'horizontal' | 'vertical';
}) {
  return (
    <div
      className={cn(
        'flex gap-4',
        orientation === 'vertical' ? 'flex-col' : 'flex-row items-center'
      )}
    >
      {STEP_LABELS.map((label, index) => {
        const isCompleted = index < api.currentStep;
        const isActive = index === api.currentStep;
        return (
          <div key={label} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => api.goTo(index)}
              className={cn(
                'flex size-8 items-center justify-center rounded-full border text-sm transition-colors',
                isActive && 'border-brand-primary bg-brand-primary text-white',
                isCompleted &&
                  'border-brand-primary bg-brand-primary/20 text-brand-primary',
                !isActive && !isCompleted && 'border-stroke text-ink-secondary'
              )}
            >
              {isCompleted ? <Check className="size-4" /> : index + 1}
            </button>
            <Typography
              textColor={isActive ? 'primary' : 'secondary'}
              weight={isActive ? 'medium' : 'normal'}
            >
              {label}
            </Typography>
          </div>
        );
      })}
    </div>
  );
}

function StepNav({ api }: { api: StepperApi<unknown> }) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={api.goBack}
        disabled={api.isFirst}
      >
        Back
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={api.goNext}
        disabled={api.isLast}
      >
        {api.isLast ? 'Done' : 'Next'}
      </Button>
    </div>
  );
}

const makeSteps = (
  orientation: 'horizontal' | 'vertical'
): StepRenderer<unknown>[] =>
  STEP_LABELS.map((label) => (api) => (
    <div
      className={cn(
        'flex w-full max-w-2xl gap-6',
        orientation === 'vertical' ? 'flex-row' : 'flex-col'
      )}
    >
      <StepIndicator api={api} orientation={orientation} />
      <div className="flex flex-1 flex-col gap-4">
        <Typography variant="lead" weight="bold">
          {label}
        </Typography>
        <Typography textColor="secondary">
          Step {api.currentStep + 1} of {api.totalSteps} — content for the
          {` ${label.toLowerCase()} `}
          step.
        </Typography>
        <StepNav api={api} />
      </div>
    </div>
  ));

export const Horizontal: Story = {
  args: { steps: makeSteps('horizontal') },
};

export const Vertical: Story = {
  args: { steps: makeSteps('vertical') },
};

export const StartOnLastStep: Story = {
  args: { steps: makeSteps('horizontal'), initialStep: 2 },
};
