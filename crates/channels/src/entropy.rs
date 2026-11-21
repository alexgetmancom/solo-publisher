//! Where OAuth nonces and PKCE verifiers come from (`crypto.randomBytes`). A
//! test hands a scripted source so a signed state can be compared bit for bit;
//! the IV `secret_box::seal` draws stays the operating system's.

pub trait Entropy {
    fn fill(&self, bytes: &mut [u8]);
}

impl<E: Entropy + ?Sized> Entropy for &E {
    fn fill(&self, bytes: &mut [u8]) {
        (**self).fill(bytes);
    }
}

/// The operating system's randomness.
pub struct OsEntropy;

impl Entropy for OsEntropy {
    fn fill(&self, bytes: &mut [u8]) {
        getrandom::getrandom(bytes).expect("the operating system has no randomness source");
    }
}

pub(crate) fn random_bytes<const N: usize>(entropy: &dyn Entropy) -> [u8; N] {
    let mut bytes = [0u8; N];
    entropy.fill(&mut bytes);
    bytes
}
