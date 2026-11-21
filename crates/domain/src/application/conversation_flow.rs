//! Transport-neutral shape of a conversational publication workflow: named
//! steps, what each expects from the transport, and how it advances.

use serde::{Deserialize, Serialize};

use crate::Result;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PublicationKind {
    Post,
    Video,
}

impl PublicationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Post => "post",
            Self::Video => "video",
        }
    }
}

/// What a step expects from the transport. Steps without one are reached by a
/// control (a button), not by something the operator sends, so a message
/// adapter must leave them alone instead of guessing. A `TextFile` step reads
/// the same answer either typed or attached as the file it was written in, so
/// an empty message there is not yet an empty answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowStepInput {
    Text,
    TextFile,
    Media,
}

/// What a step's `accept` produced: the new data and the effects it asks the
/// transport to carry out.
pub struct FlowAcceptance<D, E> {
    pub data: D,
    pub effects: Vec<E>,
}

impl<D, E> FlowAcceptance<D, E> {
    /// An acceptance with no effects: the step only changed the data.
    pub fn data(data: D) -> Self {
        Self {
            data,
            effects: Vec::new(),
        }
    }
}

/// Takes the operator's input and the current data to the next data.
pub type FlowAccept<D, I, E> = fn(I, D) -> Result<FlowAcceptance<D, E>>;

pub struct FlowStep<D, I, E> {
    pub name: &'static str,
    pub input: Option<FlowStepInput>,
    pub accept: Option<FlowAccept<D, I, E>>,
    pub next: fn(&D) -> Option<&'static str>,
    pub back: Option<fn(&D) -> Option<&'static str>>,
}

pub struct Flow<D: 'static, I: 'static, E: 'static> {
    pub kind: PublicationKind,
    pub steps: &'static [FlowStep<D, I, E>],
}

impl<D, I, E> Flow<D, I, E> {
    fn step(&self, name: &str) -> Option<&FlowStep<D, I, E>> {
        self.steps.iter().find(|step| step.name == name)
    }
}

pub struct FlowTransition<D, E> {
    pub data: D,
    pub next: Option<&'static str>,
    pub effects: Vec<E>,
}

/// Executes one step transition for an adapter; `None` when the step does not
/// exist or takes no input.
pub fn accept_flow<D, I, E>(
    flow: &Flow<D, I, E>,
    step_name: &str,
    input: I,
    data: D,
) -> Result<Option<FlowTransition<D, E>>> {
    let Some(step) = flow.step(step_name) else {
        return Ok(None);
    };
    let Some(accept) = step.accept else {
        return Ok(None);
    };
    let accepted = accept(input, data)?;
    Ok(Some(FlowTransition {
        next: (step.next)(&accepted.data),
        data: accepted.data,
        effects: accepted.effects,
    }))
}

/// The step a "back" control returns to, or `None` when nothing precedes it.
pub fn back_flow<D, I, E>(flow: &Flow<D, I, E>, step_name: &str, data: &D) -> Option<&'static str> {
    flow.step(step_name)
        .and_then(|step| step.back)
        .and_then(|back| back(data))
}

/// What the step at `step_name` expects an adapter to deliver, or `None` when
/// the step is not driven by operator input at all (or does not exist).
pub fn flow_step_input<D, I, E>(flow: &Flow<D, I, E>, step_name: &str) -> Option<FlowStepInput> {
    flow.step(step_name).and_then(|step| step.input)
}

#[cfg(test)]
mod tests {
    use super::*;

    type Data = Vec<&'static str>;

    fn record(input: &'static str, mut data: Data) -> Result<FlowAcceptance<Data, &'static str>> {
        data.push(input);
        Ok(FlowAcceptance {
            data,
            effects: vec!["saved"],
        })
    }

    static STEPS: [FlowStep<Data, &'static str, &'static str>; 3] = [
        FlowStep {
            name: "first",
            input: Some(FlowStepInput::Text),
            accept: Some(record),
            next: |_| Some("second"),
            back: None,
        },
        FlowStep {
            name: "second",
            input: Some(FlowStepInput::Media),
            accept: Some(|input, data| record(input, data).map(|accepted| FlowAcceptance::data(accepted.data))),
            next: |data| (data.len() < 2).then_some("second"),
            back: Some(|_| Some("first")),
        },
        FlowStep {
            name: "confirm",
            input: None,
            accept: None,
            next: |_| None,
            back: None,
        },
    ];
    static FLOW: Flow<Data, &'static str, &'static str> = Flow {
        kind: PublicationKind::Video,
        steps: &STEPS,
    };

    #[test]
    fn steps_advance_go_back_and_report_their_input() {
        let first = accept_flow(&FLOW, "first", "a", Vec::new()).unwrap().unwrap();
        assert_eq!((first.next, first.effects), (Some("second"), vec!["saved"]));
        let second = accept_flow(&FLOW, "second", "b", first.data).unwrap().unwrap();
        assert_eq!(
            (second.data, second.next, second.effects.len()),
            (vec!["a", "b"], None, 0)
        );
        assert!(accept_flow(&FLOW, "confirm", "c", Vec::new()).unwrap().is_none());
        assert!(accept_flow(&FLOW, "missing", "c", Vec::new()).unwrap().is_none());
        assert_eq!(back_flow(&FLOW, "second", &Vec::new()), Some("first"));
        assert_eq!(back_flow(&FLOW, "first", &Vec::new()), None);
        assert_eq!(flow_step_input(&FLOW, "second"), Some(FlowStepInput::Media));
        assert_eq!(flow_step_input(&FLOW, "confirm"), None);
        assert_eq!(FLOW.kind, PublicationKind::Video);
    }
}
