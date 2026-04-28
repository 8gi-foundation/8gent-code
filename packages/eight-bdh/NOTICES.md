# Third-party notices

This package depends on the BDH (Baby Dragon Hatchling) architecture
released by Pathway Technology, Inc. The architecture code at
`github.com/pathwaycom/bdh` is MIT licensed. The 8gent 0.1 trained
weights produced by `packages/eight-bdh/trainer/local/train_phase_0.py`
are derivative works of that architecture and are released under
Apache 2.0 alongside the rest of `8gent-code`.

The MIT license requires the copyright notice and permission notice be
included in all copies or substantial portions of the Software. We use
substantial portions of `bdh.py` at training time, so the verbatim
notice is preserved below.

---

## BDH (pathwaycom/bdh)

Source: https://github.com/pathwaycom/bdh
Paper: https://arxiv.org/abs/2509.26507

Copyright 2025 Pathway Technology, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

## Compatibility

Pathway's MIT license is compatible with the Apache 2.0 license under
which the rest of `8gent-code` is published. The combined work ships as
Apache 2.0; this notice preserves the MIT obligation for the BDH-derived
portions.

When the upstream BDH code is subtree-pulled into
`packages/eight-bdh/trainer/upstream/` (Phase 0 step 1 per spec section 5),
the upstream `LICENSE.md` will be brought in alongside it and this notice
will continue to apply to the architecture-derived portions of the
package and any released trained weights.
