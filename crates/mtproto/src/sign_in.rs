//! The one-time sign-in of the Stories account, as mtcute's `client.start`
//! ran it: phone number, the code Telegram sends (asked again until it is
//! accepted), then the two-factor password when the account has one. The
//! permanent key lands in the session file as soon as the connection is
//! made, and the home datacenter when Telegram moves the account to another.

use grammers_client::client::SignInError;
use grammers_client::tl::{enums, functions};
use grammers_client::{Client, InvocationError};

use crate::Credentials;
use crate::connection::with_client;
use crate::session::SessionFile;

/// The operator's terminal.
pub trait SignInPrompts {
    /// Asks and returns the answer, trimmed.
    fn ask(&self, question: &str) -> String;
    fn tell(&self, line: &str);
}

/// The account now signed in, named as the sign-in prints it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedIn {
    /// `@username`, or the display name of an account without one.
    pub user: String,
}

/// Signs the account in and leaves the session at `credentials.session`;
/// an account already signed in is just named.
pub async fn sign_in(credentials: &Credentials, prompts: &dyn SignInPrompts) -> Result<SignedIn, String> {
    let session = SessionFile::open_or_create(&credentials.session).map_err(|error| error.to_string())?;
    with_client(credentials.api_id, session, async |client| {
        let user = match signed_in_user(client).await? {
            Some(user) => user,
            None => sign_in_with_code(client, &credentials.api_hash, prompts).await?,
        };
        Ok(SignedIn { user: name(&user) })
    })
    .await
}

/// The current account, or `None` while the key has no sign-in bound to it.
async fn signed_in_user(client: &Client) -> Result<Option<enums::User>, String> {
    match client
        .invoke(&functions::users::GetUsers {
            id: vec![enums::InputUser::UserSelf],
        })
        .await
    {
        Ok(mut users) => Ok(users.pop()),
        Err(InvocationError::Rpc(rpc)) if rpc.code == 401 => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

async fn sign_in_with_code(
    client: &Client,
    api_hash: &str,
    prompts: &dyn SignInPrompts,
) -> Result<enums::User, String> {
    let phone = prompts.ask("Phone number (with country code): ");
    let token = client
        .request_login_code(&phone, api_hash)
        .await
        .map_err(|error| error.to_string())?;
    prompts.tell("Telegram sent a code to that account.");
    let mut password = loop {
        let code = prompts.ask("Code Telegram just sent: ");
        match client.sign_in(&token, &code).await {
            Ok(user) => return Ok(user.raw),
            Err(SignInError::InvalidCode) => prompts.tell("That code was not accepted. Try again."),
            Err(SignInError::PasswordRequired(password)) => break password,
            Err(SignInError::SignUpRequired) => {
                return Err("This phone number has no Telegram account yet; sign up in a Telegram app first.".into());
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    loop {
        let answer = prompts.ask("Two-factor password (leave empty if unused): ");
        match client.check_password(password, answer).await {
            Ok(user) => return Ok(user.raw),
            Err(SignInError::InvalidPassword(again)) => {
                prompts.tell("That password was not accepted. Try again.");
                password = again;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// The account itself, not the channel: a Story is posted by this user on
/// the channel's behalf, and signing in as the wrong one fails much later.
fn name(user: &enums::User) -> String {
    let enums::User::User(user) = user else {
        return "Deleted Account".into();
    };
    if let Some(username) = &user.username {
        return format!("@{username}");
    }
    match (user.first_name.as_deref(), user.last_name.as_deref()) {
        (None | Some(""), _) => "Deleted Account".into(),
        (Some(first), Some(last)) if !last.is_empty() => format!("{first} {last}"),
        (Some(first), _) => first.to_owned(),
    }
}
