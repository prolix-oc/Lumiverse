# Lumiverse Community License (Version 2.2)

---

_Effective Date: September 20, 2026_

_Plain-Language Preamble:_ The Lumiverse Community License is a custom source-available license that allows you to view, use, and modify the Lumiverse platform and its associated projects for personal, academic, and non-profit research purposes, while protecting the project from unauthorized commercial, governmental, or parasitic exploitation. In essence, you can use Lumiverse freely for yourself or your non-profit organization, and you can fork or modify it internally. An individual may also host an instance for friends or a wider community without charge, provided it is not used for commercial benefit and is clearly presented as an independent, unofficial instance rather than one operated, endorsed, or supported by the project founder or Lumiverse organization. However, you **must** contribute back any improvements you make, and you **cannot** redistribute the software. Commercial (for-profit) use is not covered by this license and requires a separate arrangement. Likewise, no government agency — and no entity acting on behalf of a government agency — may use Lumiverse in an official capacity. This license also forbids use of the Lumiverse name or logo without permission, and expressly prohibits the use of the Software or its source code as training data for machine learning models. The goal is to keep Lumiverse open and accessible in alignment with the ideology that software is a human right for end-users, while ensuring community enhancements are shared and preventing companies or governments from taking advantage of the software without contributing. One deliberate exception exists: the License permits community-built **extensions and integrations** — plugins, connectors, tooling, and similar separate works that interoperate with Lumiverse — to be created, published under their own open or source-available licenses, and even hosted as free services, provided they are made available entirely without charge or any form of income generation (no fees, advertising, sponsorships, or barter), their source remains open or fully reviewable by the Licensor, and they neither misrepresent themselves as official Lumiverse offerings nor serve as a disguise for public deployment of Lumiverse itself. The following terms are the legally binding conditions of the Lumiverse Community License:

## 1. Definitions

For purposes of this License, the following terms have the meanings given:

**"Improvements"** refers to any changes, additions, or derivatives of the Software that alter, in either a significant or insignificant way, the original source code, configuration, or operational behavior. **This includes, but is not limited to**: alterations to execution flow; use of new modules or libraries; insertions or changes to core modules; additions of extensions that enable communications with external platforms or utilities; modifications to deployment configurations, infrastructure-as-code, container definitions, or orchestration files; modifications to prompt templates, system instructions, or any text-based directives that alter the behavior of AI/ML components within the Software; and any other work product that derives from or builds upon the Software's codebase in a way that enhances, extends, or modifies its functionality. For the avoidance of doubt, Improvements do **not** include a Community Extension distributed in compliance with Section 2.2, except to the extent such Extension contains or constitutes a modification of the Software itself (which portion remains an Improvement subject to Section 3).

**"User-Created Instance Content"** means data that an end user creates, uploads, imports, or changes through the ordinary features or APIs of a deployed instance of the Software. This includes presets, prompt blocks, prompt text, sampler or provider settings, characters, personas, chats, world books, memories, user preferences, media, and other instance-stored data, whether created manually or imported from another source. User-Created Instance Content is not an Improvement and is not subject to the contribution-back requirement, even if it changes the output or behavior of a particular user, chat, or deployed instance. This exclusion does not apply to a change to a file, template, prompt, configuration, deployment asset, or tooling distributed with the Software, nor to any source-code or operational modification of the Software itself; those changes remain Improvements.

**"Software"** refers to the Lumiverse platform and all related Lumiverse projects, including their source code, documentation, configuration files, prompt templates, deployment scripts, and any associated materials made available under this License.

**"Licensor"** refers to the copyright holder(s) offering the Software under this License. The Licensor is the Lumiverse project founder, Darran Hall (also known as **Prolix OCs**), and the Lumiverse organization authorized by him.

**"Licensee"** or **"You"** means the individual or legal entity exercising the permissions granted by this License. Where the Licensee is a legal entity, "You" includes all Affiliates of that entity.

**"Affiliate"** means any entity that directly or indirectly controls, is controlled by, or is under common control with the Licensee, where "control" means: (i) ownership or control of more than fifty percent (50%) of the voting securities or equivalent ownership interests; or (ii) the power to direct or cause the direction of the management and policies of such entity, whether through ownership, contract, or otherwise.

**"Contributor"** means any individual or entity (including the Licensor and others) that submits or has submitted any modifications, enhancements, or other contributions to the Software that are accepted into the official codebase by the Licensor.

**"Personal Use"** means use of the Software by an individual solely for personal, private, and non-commercial purposes (which may include personal education or experimentation).

**"Free Community Hosting"** means operation of an instance of the Software by an individual Licensee through which other persons may access the Software over a network, provided that: (i) the instance and access to it are provided without charge and without any direct or indirect commercial benefit to the Licensee or another party, including fees, access-linked donations, advertising, sponsorships, sale or use of participant data, or barter; (ii) the Licensee does not state or imply that the instance is operated, approved, supported, or endorsed by the Licensor, and complies with Section 8; and (iii) the Licensee does not distribute any copy of the Software to a participant. The number of participants, their relationship to the Licensee, and whether access is public or invite-only do not affect qualification as Free Community Hosting. Free Community Hosting is a Permitted Use and, notwithstanding the definition of Public Use or Commercial Use, is neither Public Use nor Commercial Use under this License. All other restrictions and conditions of this License, including Sections 3, 6, 7, and 8, continue to apply.

**"Non-Profit Organization"** means an entity that is not operated for profit, including charitable organizations qualified under Section 501(c)(3) of the United States Internal Revenue Code, and similar organizations worldwide (such as educational or research institutions that are not-for-profit). **"Non-Profit Use"** means use of the Software by a Non-Profit Organization for its non-commercial activities.

**"Internal Use"** means use of the Software within a single organization (which may be a for-profit company, non-profit, or academic institution) solely for that organization's own internal research, development, or operations, and not to provide services, capabilities, data, outputs, or competitive intelligence to any external party, Affiliate, or third-party beneficiary. Internal Use includes allowing access to the Software by employees or contractors of the organization strictly for internal purposes.

**"Public Use"** (or **"Public-Facing Use"**) means any use of the Software that intentionally makes the Software, or any of its functionality, outputs, or capabilities, accessible to any person or entity other than You or your internal organizational users. This includes, but is not limited to, making the Software available through a website, API, cloud or SaaS platform, chatbot interface, or as part of any product or service that is accessible to customers, users, or the general public outside your organization.

**"Commercial Use"** means any use of the Software that is intended for or results in commercial gain or advantage, or any use by a for-profit entity **outside** of Internal Use. In particular, Commercial Use includes, without limitation: (i) using the Software as part of services provided to third parties (whether paid or unpaid); (ii) using the Software to develop or operate a product for sale, license, or external deployment; (iii) any deployment or use of the Software that is part of revenue-generating activities; or (iv) using the Software, its outputs, or data derived from its operation to inform, train, or develop any product, service, or offering that is subsequently provided to third parties. For the avoidance of doubt, use of the Software solely for Internal Use by a for-profit business, without providing the Software, its output, or derivative value to any third party or Affiliate, is **not** considered Commercial Use under this License. Free Community Hosting that satisfies every condition in its definition is also **not** Commercial Use under this License.

**"Government Entity"** means any government, governmental agency, department, office, or instrumentality at any level (municipal, state/provincial, national/federal, or supranational), as well as any organization, contractor, subcontractor, grantee, or other entity performing work on behalf of, at the direction of, or funded primarily by such a government entity.

**"AI/ML Training"** means the use of the Software's source code, documentation, configuration files, prompt templates, or any other materials covered by this License as input data for training, fine-tuning, distilling, or otherwise developing any machine learning model, artificial intelligence system, or automated code generation tool, whether or not the resulting model is distributed or deployed.

**"Extension"** refers to any software, configuration, data, or documentation created by You that interoperates with, communicates with, or augments the Software — including plugins, connectors, adapters, clients, tooling, themes, language bindings, and integrations with external platforms or utilities — but that is maintained and distributed as a separate work, and that is not itself a modification of the Software's source code, configuration, or prompt templates, except for de minimis excerpts as permitted under Section 2.2(b)(i).

**"Community Extension"** means an Extension that is created, distributed, and (where applicable) operated in full compliance with Section 2.2.

**"Hosted Community Extension"** means a Community Extension that You operate as a remotely accessible service (including a website, API, relay, bridge, or similar) through which third parties may access or use that Extension over a network, as permitted under Section 2.2(c).

**"Open Distribution"** means distribution of a work under license terms that: (i) make the work's complete human-readable source code publicly available at no charge; (ii) grant all recipients royalty-free rights to use, modify, and redistribute the work, at minimum for personal, non-commercial, and internal purposes; and (iii) do not prohibit recipients from further distributing the work or modifications of it. Licenses approved by the Open Source Initiative satisfy this definition, as do source-available licenses (including non-commercial source-available licenses) that grant the equivalent freedoms.

## 2. Grant of License and Permitted Uses

Subject to your compliance with **all** terms and conditions of this License, the Licensor hereby grants You a worldwide, royalty-free, non-exclusive, non-transferable, and non-sublicensable license to use, reproduce, and modify the Software, **solely** for the following permitted purposes (collectively, "Permitted Uses"):

a. **Personal Use** — You may use, run, and modify the Software for your own personal, non-commercial purposes.

b. **Non-Profit Use** — If you are a Non-Profit Organization (or an individual using the Software for non-profit academic or research purposes), you may use, run, and modify the Software for your organization's internal, non-commercial activities.

c. **Internal Use (Including Internal Corporate Use)** — You may use, run, and modify the Software within your organization for internal development, testing, and operations. This includes for-profit companies using the Software internally (for example, for internal research or to assist in internal business functions), **provided** such use is not a Public Use, is not part of providing services or products to any third party or Affiliate, and does not produce outputs, data, or derivative value that is subsequently made available to or exploited by any external party or Affiliate.

d. **Free Community Hosting** — An individual may use, run, and host the Software for Free Community Hosting. This permission allows other persons to access the hosted instance solely as defined in "Free Community Hosting" and does not grant any participant a right to receive, copy, modify, redistribute, or independently host the Software.

**No Distribution Rights:** This License **does not** grant you any right to distribute, publish, or make available copies of the Software or any modified version of the Software to **any** other party. Except for sharing within your own organization for Internal Use, you may not transfer, sublicense, rent, sell, lease, or otherwise convey the Software (or any portion of it) to anyone else. The source code may be publicly visible in an official Lumiverse repository, but You are not licensed to redistribute it yourself. **All distribution rights are reserved to the Licensor (the Lumiverse organization and its founder).** The Licensor is the only party authorized to release or distribute the Software (including any modified versions) to the public. The limited right to publish and distribute Extensions as Community Extensions under Section 2.2 is an express exception to this paragraph; such distribution does not constitute distribution of the Software or of any modified version of the Software.

**All Other Rights Reserved:** Any use of the Software outside the scope of these Permitted Uses (and outside the other express terms of this License) is prohibited. All rights not expressly granted to You in this License are reserved by the Licensor. You acquire no rights or licenses to the Software other than those expressly granted herein. You may not sublicense, transfer, or assign this License to any third party. This License also does not limit the Licensor's right to offer the Software under different terms (or to refuse contributions or usage from any party in violation of these terms).

### 2.1 Academic and Research Publication Rights

If You are using the Software for academic or research purposes, the following additional rights are granted:

a. **Publication of Results:** You may publish and present research results, findings, benchmarks, and analyses derived from Your use of the Software in academic journals, conference papers, research reports, theses, dissertations, and similar scholarly works. This includes the right to describe the Software's functionality and to discuss how it was used in your research.

b. **Citation and Attribution:** When publishing such research, You must appropriately cite the Software and its creators. The recommended citation format will be provided in the Software's documentation or repository. At minimum, citation should include the name "Lumiverse," the version used, the name of the creator (Darran Hall / Prolix OCs), and a reference to the Software's website or repository.

c. **Screenshots and Output Examples:** You may include limited screenshots of the Software's interface and examples of its output in your publications, provided these are directly relevant to illustrating your research findings.

d. **Code Snippets:** You may include small excerpts of the Software's code (not to exceed 100 lines) in your publications for the sole purpose of explaining or discussing specific technical features or methods relevant to your research.

e. **Limitations:**

  i. This right to publish does not override Your obligation to contribute back Improvements as outlined in Section 3.

  ii. You may not publish the entire source code or substantial portions of it.

  iii. Publications must not enable others to circumvent the licensing terms of the Software.

  iv. You may not publish confidential information about the Software that is expressly marked as such.

f. **Pre-Publication Review:** While not required, the Licensor welcomes the opportunity to review publications that substantially focus on the Software prior to submission, to ensure technical accuracy and appropriate attribution. The Licensor commits to a timely review (typically within 14 days) and will not unreasonably withhold approval.

The Licensor recognizes the importance of academic freedom and the publication of research findings, and these rights are intended to support the advancement of knowledge while respecting the Licensor's intellectual property rights.

### 2.2 Community Extensions and Integrations

Notwithstanding Sections 3, 4, and 5.5(a), and subject to all conditions of this Section 2.2, the Licensor grants You the limited right to create, publicly distribute, maintain, and (under Section 2.2(c)) host Extensions. The purpose of this section is to enable a community ecosystem of extensions and integrations around the Software while keeping that ecosystem non-commercial, open, and non-exploitative.

a. **Grant.** You may make an Extension available to the public — for example, by publishing its source code in a public repository, or by publishing installable packages through a package registry or marketplace — provided You do so in full compliance with this Section 2.2. Distribution under this section is an exception to the restrictions of Section 2 (No Distribution Rights), Section 3.2, Section 4.1, and Section 5.5(a), and remains conditioned on Your continuing compliance.

b. **Conditions.** You may distribute an Extension as a Community Extension only if all of the following conditions are satisfied:

  i. **Separation.** The Extension is a separate work and does not incorporate the Software's source code, except for excerpts that do not exceed one hundred (100) lines in aggregate, which must retain all original copyright and license notices (per Section 4.4).

  ii. **No Profit.** You must distribute the Extension free of charge, and You must not generate any income or other value from the Extension or its distribution, directly or indirectly. This prohibits, without limitation: any sale, license fee, subscription, paid tier, paywall, or required payment for access to the Extension or any of its features; any advertising or sponsorship revenue attributable to the Extension; and any barter-based arrangement in which access to, features of, or support for the Extension — or any capability derived from the Software or the Extension — is exchanged for anything of value (including goods, services, data, or other consideration). Voluntary donations are permitted only if they are entirely uncoupled from access, features, or support.

  iii. **Open Distribution.** You must distribute the Extension (including its complete source code) under terms meeting the definition of Open Distribution in Section 1. You may not distribute the Extension in closed-source or proprietary form, you may not withhold or obfuscate its source code, and you may not gate access to its source code behind any payment, registration, or other barrier that prevents free public inspection.

  iv. **No Circumvention.** An Extension must not be designed or used primarily to circumvent this License — including by enabling or facilitating AI/ML Training, by facilitating use of the Software by Government Entities, or by any other scheme to enjoy rights not granted herein. Sections 6 and 7 apply to Extensions and their distribution.

  v. **Marks and Non-Endorsement.** Section 8 applies to Extensions. The Extension's name must not include "Lumiverse" or any confusingly similar name, and the Extension must clearly identify itself as an independent, unofficial work that is not affiliated with, endorsed by, or supported by the Licensor, while it may truthfully state that it is designed to interoperate with the Software.

c. **Hosted Community Extensions.** You may operate a Community Extension as a hosted service that is accessible to third parties over a network (a "Hosted Community Extension"), including a service that enables third parties to interact with the Software or with instances of the Software operated by You or by such third parties. A Hosted Community Extension is an express exception to the prohibition on Public Use in Section 4.2, subject to all of the following:

  i. All conditions of this Section 2.2 — including the No Profit condition, which applies equally to hosted access — continue to apply.

  ii. **Openness or Full Review.** Either (a) the complete source code and configuration of the hosted service — meaning all software and configuration You operate as part of the service, other than the Software itself and unmodified third-party dependencies — is publicly available under Open Distribution terms, with no proprietary blobs, closed components, or withheld portions; or (b) upon the Licensor's reasonable request, You will provide the Licensor complete access to that source code and configuration for compliance review, in full and without gaps. For a Hosted Community Extension, satisfying this subsection also satisfies the Open Distribution condition in (b)(iii). Failure to provide such access when requested is a material breach of this License.

  iii. **No Substitution for Public Deployment.** The hosted service must remain an Extension within the meaning of Section 1 — a separate work that interoperates with the Software — and must not serve as a mere vehicle for offering the Software itself, or its core functionality as a whole, to the public as the service. Whether a hosted offering is a genuine Extension or a disguised public deployment of the Software shall be determined based on its substance, not its form.

d. **Relationship to Section 3 (Contribute-Back).** A Community Extension is not an "Improvement" and is exempt from the contribution requirement of Section 3.1, provided it contains no modification to the Software itself. To the extent an Extension includes changes to the Software's own source code, configuration, or prompt templates, those changes remain Improvements subject to Section 3 in their entirety and must be contributed under the Lumiverse Community License. Nothing in this section obligates You to license Your Extension to the Licensor, though You are welcome to offer it for incorporation into the official project under this License.

e. **No Endorsement or Warranty.** Extensions (including Hosted Community Extensions) are third-party works. The Licensor does not author, endorse, or support any Extension, and has no liability for Extensions or their effects (see Sections 12 and 13). You are solely responsible for Your Extension, including for any claims arising from its distribution, operation, or use.

f. **Enforcement.** Distributing or operating an Extension in violation of this Section 2.2 constitutes unauthorized distribution of a work derived from or interoperating with the Software, is a material breach of this License, and is subject to termination under Section 14 — including the obligation to cease distribution and operation and to destroy copies.

_(In plain terms: you can build plugins, connectors, and integrations for Lumiverse and share them publicly under your own open or source-available license — MIT, GPL, a PolyForm-style license, your choice — and you can even run one as a free hosted service that others can reach over the network, as long as the service's full code is either publicly open or fully reviewable by the project founder with nothing hidden. In exchange: everything must be free — no fees, no ads, no sponsorships, no barter, nothing of value changing hands; the source stays open and inspectable; you don't dress it up as official Lumiverse; and you don't use an integration as a disguise for hosting Lumiverse itself. Changes to Lumiverse's own code still have to come back to the project.)_

## 3. Contribution of Modifications and Improvements

If You modify, improve, extend, or otherwise change the Software, or create any derivative works based on the Software, **and** those changes enhance or add to the functionality, performance, configuration, or operational behavior of the Software (collectively, "Improvements"), You are **obligated** to contribute those Improvements back to the official Lumiverse project as outlined below:

**3.1 Requirement to Contribute Back:** As a condition of this License, You must submit or offer **all** Improvements — in their entirety, not in reduced, partial, or abstracted form — to the Licensor for potential incorporation into the official Software repository. Typically, this can be done by making a good-faith attempt to submit a merge request or pull request to the official Lumiverse source code repository (or by another method designated by the Lumiverse organization). You must contribute such Improvements in a timely manner after developing them (generally, no later than 30 days after the Improvement is first functional), and You may continue to use your modified version **only** so long as you are in compliance with this contribution requirement. For the avoidance of doubt: submitting a minimal, stripped-down, or obfuscated version of an Improvement while retaining a more complete version privately constitutes a violation of this section. The contributed version must be functionally equivalent to the version You use or deploy internally. If You choose not to contribute your Improvements as required, or if you do not wish to have them governed by this License, then you do not have the right to deploy or use those Improvements (i.e., you must cease using your modified version or obtain a separate license). The intent of this section is to ensure that the community benefits from all enhancements and that no functional improvement is kept proprietary.

**3.2 License and Copyright for Contributions:** By submitting an Improvement to the Licensor (for example, via a pull request) or by allowing it to be integrated into the Software, You agree to license your contribution under the terms of this Lumiverse Community License. You retain copyright ownership of your contributions, but you hereby grant the Licensor and all other Licensees a perpetual, irrevocable, worldwide, royalty-free license to use, reproduce, modify, and distribute your contributed code as part of the Software under this License. Once accepted by the Licensor, any contributed Improvement will become part of the Software and will be made source-available under this same License. You may not submit contributions under any other license or terms; all contributions to Lumiverse must be provided under the Lumiverse Community License to ensure consistency and source availability.

**3.3 No Proprietary or Restricted Code:** You agree that you will **not** contribute any code, library, dataset, prompt template, or other content to the Software that (a) is encumbered by patents, copyrights, trade secrets, or other intellectual property rights of a third party **without** appropriate authorization or licensing; (b) is subject to any license terms (including your own proprietary terms or open-source licenses) that would require, as a condition of use, modification, or distribution of such contribution, compliance with terms incompatible with this License; or (c) would otherwise place the Lumiverse project or its users at legal risk or under additional restrictions. In short, **no contribution may "poison" the codebase** with patent traps or conflicting licenses. By contributing, You represent and warrant that you have all necessary rights to submit the contribution and to license it under these terms, and that to the best of your knowledge, your contribution does not infringe or misappropriate anyone else's rights and will not require any additional license or fee for the Lumiverse project or its users to use. If You are aware of any patents (yours or third-party) that **might** read on your contribution, You agree to disclose this in the contribution notes.

**3.4 Disclaimer for Unaccepted Contributions:** Simply submitting an Improvement via pull request or other means does not guarantee that the Licensor will accept or merge it. The Licensor has sole discretion over which contributions are integrated into the official project. If your Improvements are not accepted, you are still bound by the non-distribution terms of this License — you may use your variant internally or for Free Community Hosting under Section 2(d), but you **may not distribute** it (unless you obtain a separate license or permission). Unaccepted improvements therefore remain subject to the same use restrictions (no commercial use, except qualifying Free Community Hosting, etc.) as the original Software. You are encouraged to work with the maintainers to get Improvements accepted rather than maintaining significant private forks.

**3.5 Attribution and Recognition of Contributors:** The Licensor values the contributions made to the Software and is committed to providing appropriate attribution. Contributors who submit Improvements that are accepted into the Software will be acknowledged in the following ways:

a. **Contributor Credits File:** The Software repository shall maintain a CONTRIBUTORS.md file that lists individuals who have made significant contributions, along with a brief description of their contributions when applicable. The Licensor will update this file periodically as new contributions are accepted.

b. **Commit History:** For code contributions merged via pull requests or similar mechanisms, the original contributor's information will be preserved in the commit history, providing a permanent record of authorship.

c. **Documentation Attribution:** When specific features or improvements can be attributed to a particular contributor, the relevant documentation may acknowledge that contribution explicitly.

d. **Optional Anonymity:** Contributors may choose to remain anonymous or use a pseudonym rather than their real name in attribution. Contributors wishing to modify their attribution or remove it for privacy reasons may contact the Licensor directly.

The Licensor reserves the right to determine what constitutes a significant contribution warranting explicit attribution beyond the commit history. While attribution is important, it does not alter the licensing terms or ownership rights as outlined elsewhere in this License.

_(In summary: if you improve Lumiverse, you must try to contribute those improvements back — in full, not stripped down — under this license. All contributed code will become part of the open codebase if accepted. Don't contribute anything that brings legal baggage into the project.)_

## 4. No Unauthorized Distribution or Public Deployment

**4.1 No Redistribution:** Except as expressly allowed for Contributions (per Section 3.1), for Community Extensions (per Section 2.2), or for internal sharing within your organization, You may not distribute, publish, release, or disseminate the Software or any derivative works of the Software to any third party. This prohibition on distribution applies to both source code and compiled/object code forms, and it includes uploading the Software to any public repository, package manager, container registry, or distribution channel that is not controlled by the Licensor. You are not allowed to re-post the code or binaries publicly, include it in any open source project release of your own, or otherwise share it outside the bounds of your own personal or internal use. The **exclusive** right to distribute the Software (or to authorize distribution) belongs to the Licensor (Darran Hall and the Lumiverse organization).

**4.2 No Public-Facing Service or Deployment:** Except for Free Community Hosting under Section 2(d) and Hosted Community Extensions operated in compliance with Section 2.2(c), You are expressly **forbidden** from making the Software available for use by anyone other than yourself or your Internal Users. This means You **cannot** deploy or use the Software in any public-facing or externally accessible manner — for example, you may not host a website or service powered by Lumiverse for users outside your organization; you may not offer Lumiverse as a service (SaaS) or otherwise enable others to use or interact with Lumiverse functionality over a network; and you may not integrate Lumiverse into a product (open-source or proprietary) that is distributed to or accessible by third parties. Any such public deployment or external availability of the Software is a violation of this License. The only entities permitted to deploy or offer Lumiverse to the public (whether free or for a fee) are the Licensor and those specifically authorized in writing by the Licensor. If you have improvements or features you wish to see in a public Lumiverse service, you are encouraged to contribute them to the official project rather than running your own public instance. A qualifying Free Community Hosting instance is not a public deployment, but it must continuously satisfy every condition in the definition of Free Community Hosting; a host that charges for, commercially benefits from, or misrepresents its instance loses this exception. This prohibition is also subject to an express exception for Hosted Community Extensions operated in compliance with Section 2.2(c): publishing or distributing an Extension is not a public deployment of the Software, and a qualifying Hosted Community Extension may enable third parties to interact with the Software over a network. However, hosting or offering the Software itself — or its core functionality as a whole — outside Free Community Hosting remains exclusively reserved to the Licensor and those it authorizes in writing, and using an Extension as a mere vehicle for such hosting is a circumvention of this License.

**4.3 Internal Use Sharing:** If you are using the Software internally (e.g., within a company or research lab), you may allow access to the Software by your colleagues, employees, or contractors as needed for that internal use, and you may share modified versions with them, **provided** this remains solely within your organization and they are bound to respect the terms of this License. Such internal sharing is not considered "distribution" for the purposes of this License. However, you must ensure that anyone within your organization who receives a copy of the Software or modified Software is made aware of, and agrees to abide by, the terms of this License (including the prohibition on further distribution and the requirement to keep changes under this License). If you provide any portion of the Software to your internal team, you should include a copy of this License and any relevant copyright notices.

**4.4 No Removal of Notices:** You must not remove or alter any copyright, author attribution, or license notices that are included with the Software. All copies of the Software, including any modified versions or portions you retain for Internal Use, must retain any existing notices (e.g., copyright statements) and a copy of this License text. This ensures that anyone interacting with the code is aware of its license and origin.

## 5. Commercial Use Restrictions and Separate Licensing

**5.1 Non-Commercial Only (Default):** This License allows **only** non-commercial usage of the Software (except for limited internal business use and Free Community Hosting as outlined). **Any** use of the Software that is commercial in nature or for-profit, except purely internal use or Free Community Hosting, is **not** permitted under these terms. If You are an individual or entity intending to use the Software in a revenue-generating context, or as part of providing goods or services for a fee (or as part of your business offerings even if provided for free), you do **not** have rights to do so under this License without explicit permission.

**5.2 Separate Commercial License Required:** If You (or your company) wish to use the Software for **commercial purposes** or any other use that falls outside the Permitted Uses of Section 2, You must obtain a separate commercial license or written permission from the Licensor. This includes (but is not limited to) using Lumiverse as part of a product offering, incorporating Lumiverse into a proprietary software solution that is sold or licensed, using Lumiverse to provide services or SaaS to third parties, or deploying Lumiverse in any customer-facing capacity. To inquire about a commercial or special license, contact the Lumiverse team at **team@lumiverse.app**. The terms of such a commercial license (including fees, royalties, or other conditions) will be determined between You and the Licensor outside of this Lumiverse Community License.

**5.3 Fair Internal Use vs. Commercial Exploitation:** For the avoidance of doubt, **Internal Use by a for-profit entity** (for example, using Lumiverse internally to analyze data or improve your business's operations) is permitted without a separate license, as long as the use remains entirely internal and not part of providing a service or product to others, and does not produce outputs, data, or derivative value that is subsequently made available to any third party or Affiliate. This allowance is made in the spirit of research and innovation. However, if your internal use of Lumiverse is a precursor to, part of a plan to, or results in the offering of a product or service externally, or otherwise derives direct or indirect commercial benefit from Lumiverse that extends beyond your organization, you **must** contact the Licensor for a proper license before such use. The Licensor reserves the right to determine what constitutes Commercial Use and may offer custom licensing to accommodate innovative uses that benefit both the user and the community.

**5.4 No Franchise, Multiparty, or Affiliate Circumvention:** You may not circumvent the intent of this section by, for example: forming a nonprofit or intermediary solely to provide Lumiverse to a commercial entity; having an affiliated entity use Lumiverse internally and then pass results, outputs, data, or derivative value to a commercial Affiliate; structuring subsidiaries, shell companies, joint ventures, or other corporate arrangements to route Lumiverse's value to a for-profit beneficiary while technically maintaining "non-commercial" use at the entity level; or engaging any similar stratagem. Such arrangements will be considered a violation of the non-commercial restriction regardless of the formal corporate structure involved. Any arrangement in which a third party (other than the Licensor or an authorized party) benefits from Lumiverse in a commercial context is disallowed unless separately licensed.

**5.5 License Compatibility and Interaction with Other Licenses:**

a. The Lumiverse Community License is a custom source-available license that is not directly compatible with major open-source licenses including GPL, MIT, Apache, or BSD licenses. This means:

  i. You cannot incorporate code licensed under the Lumiverse Community License into projects that are distributed under open-source licenses without separate permission from the Licensor. This restriction does not apply to Community Extensions distributed in compliance with Section 2.2 (subject to the excerpt limit in Section 2.2(b)(i)).

  ii. You cannot relicense Lumiverse or derivative works under any open-source license.

b. **Dependencies and Libraries:** The Software may utilize third-party libraries or components that are themselves licensed under various open-source licenses. Such use of third-party components does not change the license terms for the Software itself. A list of third-party dependencies and their licenses is maintained in the repository.

c. **Integration with Other Software:** You may create integration points or wrappers that allow the Software to interoperate with other software, including open-source software, provided that:

  i. The integration maintains a clear separation between the Software and the other software.

  ii. The integration does not incorporate substantial portions of the Software's code into the other software.

  iii. You do not attempt to circumvent the restrictions of this License through such integration.

The separate right to publish, distribute, and host such integrations as Community Extensions is set out in Section 2.2.

d. **Dual Licensing:** If you wish to combine the Software with code under incompatible licenses for distribution, or to use the Software in ways not permitted by this License, you must negotiate a separate commercial license with the Licensor as described in Section 5.2.

The Licensor may, at its sole discretion, grant exceptions to these compatibility restrictions on a case-by-case basis, particularly for non-commercial or research purposes.

_(In summary: If you want to do anything commercial with Lumiverse — whether running it as a service, embedding it in a product you sell, or any for-profit use beyond internal R&D — you need to get permission and likely pay for a commercial license. Lumiverse is free for personal and non-profit use, not for companies to monetize without contributing. Routing value through subsidiaries, affiliates, or shell structures is still a violation.)_

## 6. No Government Use

**6.1 Prohibition on Government Institution Use:** The use of the Software by any Government Entity (as defined in Section 1) in an official or institutional capacity is **expressly prohibited** under this License. This means no national government, state or provincial government, city or local government, or any of their agencies, departments, or subdivisions may use, deploy, copy, or modify the Software as part of their official functions, operations, or services. The License is not intended for governmental use, and no license rights are granted for such use.

**6.2 No Acquisition on Behalf of Government:** You represent and warrant that you are not a Government Entity, and you are not obtaining or using the Software on behalf of, at the direction of, or for the benefit of any Government Entity. You further agree that you will not transfer or provide access to the Software to any Government Entity. Use of the Software, even if publicly available, by any Government Entity is considered an unlicensed (and unauthorized) use and is a violation of these terms.

**6.3 No Government Contractor Use:** This prohibition extends to any contractor, subcontractor, grantee, or other entity that is performing work under a government contract or grant, to the extent that such work involves or benefits from the Software. If You are a government contractor and wish to use the Software for purposes unrelated to any government contract, You must be able to demonstrate a clear and verifiable separation between your government-contracted work and your use of the Software. The burden of proof for such separation rests entirely with You.

**6.4 Personal Use by Government Employees:** Notwithstanding the above, an individual who is an employee or officer of a Government Entity may download, install, or use the Software for their **own Personal Use** (for example, on a personal computer at home, for personal research or learning), as long as such use is wholly outside the scope of their official duties and not on behalf of the Government Entity. Such personal usage by government personnel is subject to all the same terms and restrictions of this License and confers no rights to the Government Entity itself. If you are a government employee, you must ensure that you are acting in a private capacity when using the Software and not violating any policies of your employer by doing so.

**6.5 Exception by Licensor Approval:** The only circumstance in which Government Entity use is allowed is if the Licensor provides a separate written license or permission explicitly for that Government Entity. Such permission would be given at the sole discretion of the Licensor and would likely include additional terms or limitations. Without such explicit permission, any governmental use is unlicensed.

_(In plain terms: No government agency, government contractor working in an official capacity, or entity acting on behalf of a government is allowed to use Lumiverse under this license. Lumiverse is meant for the public and academia, not for government projects, unless the founder explicitly agrees otherwise. Government employees can tinker with it personally at home, but they can't bring it to work or use it for their government job.)_

## 7. No AI/ML Training Use

**7.1 Prohibition on AI/ML Training:** You may **not** use the Software, its source code, documentation, configuration files, prompt templates, or any other materials covered by this License as training data, fine-tuning data, evaluation data, or input of any kind for the development of machine learning models, artificial intelligence systems, large language models, code generation tools, or similar automated systems. This prohibition applies regardless of whether the resulting model or system is distributed, deployed commercially, or used internally.

**7.2 Scraping and Automated Collection:** You may **not** use any automated means (including but not limited to web scrapers, crawlers, spiders, or automated data collection tools) to extract, copy, or collect the Software's source code or associated materials for any purpose not expressly permitted by this License, including but not limited to the creation of datasets for AI/ML Training.

**7.3 Scope of Prohibition:** This prohibition covers all forms of machine learning, including but not limited to: supervised learning, unsupervised learning, reinforcement learning, transfer learning, few-shot learning, knowledge distillation, and any technique that uses the Software's materials as a basis for automated pattern extraction or model development.

**7.4 No Indirect AI/ML Training:** You may not provide or make available the Software or its materials to any third party for the purpose of AI/ML Training, nor may you use an intermediary or service to accomplish indirectly what this section prohibits directly.

_(In plain terms: You cannot feed Lumiverse's code, docs, prompts, or any part of this project into an AI model for training. Period. Not directly, not through a middleman, not through any clever technical workaround.)_

## 8. No Trademark or Branding Rights

This License does **not** grant You any rights to use the names, trademarks, service marks, or logos associated with the Lumiverse project or the Licensor (including "Lumiverse" and "Prolix OCs"). You may not use "Lumiverse" or any confusingly similar name for a fork, derivative project, or any software based on the Software without prior written permission from the Licensor. You also may not claim or imply endorsement by, or partnership with, the official Lumiverse project or the Licensor without permission.

Specifically:

a. You shall not use the term "Lumiverse" as part of the name of any modified version of the Software that you make for internal use, nor for any software or service you create that is related to the Software. When referring to your modifications internally or in contributed code, you should maintain attribution to the original project (for example, "based on Lumiverse") but not misrepresent your version as the official Lumiverse.

b. You shall not use any Lumiverse logos, graphics, or trademarks in your own project's branding, marketing, or documentation, except to truthfully state that your work is derived from or compatible with Lumiverse (and such statements should include a disclaimer that you are **not** the official Lumiverse provider).

c. All goodwill associated with the "Lumiverse" name and trademarks remains with the Licensor. Misuse of the Licensor's marks will be considered a breach of this License. If you have questions about acceptable use of Lumiverse's name or branding (for example, academic papers or comparisons), please contact the Licensor for guidance.

_(In short: You can talk about Lumiverse and factually state your code is based on it, but you cannot brand your project or service with the Lumiverse name or logos. Only the official Lumiverse organization can use that branding.)_

## 9. No Reverse Engineering

**9.1 Prohibition:** To the extent any portion of the Software is distributed in compiled, obfuscated, minified, or non-source form, You may **not** reverse engineer, decompile, disassemble, or otherwise attempt to derive the source code of such portions, except to the extent that such activity is expressly permitted by applicable law notwithstanding this limitation.

**9.2 Clarification:** This section does not restrict Your ability to read and study the Software's source code where it is made available in source form under this License. This restriction applies only to compiled or obfuscated components.

## 10. Output and Generated Content

**10.1 User-Generated Content:** Content generated by end-users through their use of the Software (such as chat messages, creative writing, or other user inputs and the AI-generated responses to them) is not claimed by the Licensor. Ownership of such content is governed by the terms of service of the deployed Lumiverse instance and any applicable third-party AI provider terms.

**10.2 No Implied License Through Output:** The generation of output by the Software does not grant any additional license rights to the Software itself. You may not use the existence of outputs to claim rights to the underlying Software, its source code, or its operational methods.

**10.3 User-Created Instance Content Not an Improvement:** For the avoidance of doubt, User-Created Instance Content, including end-user-generated content and AI-generated responses produced during ordinary use of the Software, is not an "Improvement" under Section 3 and is not subject to the contribution-back requirement. In particular, an end user's creation, upload, import, editing, selection, or use of a preset, prompt block, or other instance-stored setting does not become an Improvement merely because it affects a particular instance's prompt assembly, output, or behavior. Only changes to the Software itself or to artifacts distributed with it remain subject to Section 3, as specified in the definition of User-Created Instance Content.

## 11. Patent License and Patent Claims

**11.1 Patent License from Licensor:** The Licensor hereby grants to You a perpetual, worldwide, royalty-free, non-exclusive license under any patent claims owned or controlled by the Licensor that would be infringed by your use of the unmodified Software as permitted by this License. This means the Licensor promises not to sue You for patent infringement for using the Software as allowed, and You are allowed to use any patented technology that is part of the Software. This patent license extends only to the Software as provided by the Licensor (and Contributions accepted into the Software), and not to any modifications or combinations you may make that include additional technology not part of the Software.

**11.2 Patent License from Contributors:** Similarly, each Contributor to the Software, by contributing and having their contribution accepted into the codebase, grants to all Licensees a perpetual, worldwide, royalty-free, non-exclusive patent license under any patent claims owned or controlled by that Contributor which are necessarily infringed by the contribution itself or by the combination of that contribution with the rest of the Software. This ensures that no Contributor (including the Licensor, in their role as a Contributor for new code) can submit code and later exercise a patent to block its use. If a Contributor is not authorized to grant such patent license for any part of their contribution, they should not contribute that part.

**11.3 Patent Non-Assertion and Termination:** If You (or any party affiliated with You, including any Affiliate) initiate a lawsuit or any legal proceeding (including a cross-claim or counterclaim in a lawsuit) against the Licensor, any Contributor, or any other Licensee of the Software, alleging that the Software (or any portion of it) infringes a patent that You own or control, then any patent licenses granted to You under this License (by any party) shall terminate as of the date such claim is filed. **You cannot both use this Software and sue the project or its users for patent infringement regarding this Software.** This clause is intended to protect the community from patent aggression. The termination in this section is automatic and self-executing; no further action by the Licensor or any Contributor is required to effect it.

**11.4 No Patent Warranty:** The Licensor and Contributors do **not** guarantee that the Software is free of third-party patent claims. While each Contributor promises not to sue Licensees for patents they hold, it is possible that third parties not involved in the project may have patent rights that cover aspects of the Software. (See Section 12 regarding disclaimer of liability for such issues.) You are responsible for using the Software in compliance with applicable patent laws. However, should the Licensor become aware of a third-party patent that plausibly reads on the Software, the Licensor may at its discretion attempt to remove or re-engineer the affected component in future releases.

## 12. Disclaimer of Warranty

**THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND.** THE LICENSOR, CONTRIBUTORS, AND AFFILIATED PARTIES **EXPRESSLY DISCLAIM ALL WARRANTIES AND CONDITIONS**, EXPRESS OR IMPLIED, STATUTORY OR OTHERWISE, INCLUDING (BUT NOT LIMITED TO) WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, **NON-INFRINGEMENT** OF INTELLECTUAL PROPERTY RIGHTS, **SYSTEM INTEGRATION**, OR **ACCURACY**. You accept the Software with all faults and without any warranty that it will meet your needs or expectations, that it will be error-free or uninterrupted, or that any defects can or will be corrected. **No oral or written information or advice** given by the Licensor or any of its agents shall create any warranty. The entire risk as to the quality and performance of the Software is with You, the user.

_(This means that you cannot hold the Licensor or contributors responsible if the Software doesn't work as intended, or if it has bugs, or if it infringes someone else's IP, etc. You use it at your own risk.)_

## 13. Limitation of Liability

To the maximum extent permitted under applicable law, in no event will the Licensor or any Contributor be liable to You for any damages of any kind arising out of or in connection with this License or the use or performance of the Software, **even if** the Licensor or Contributor has been advised of the possibility of such damages. This exclusion of liability includes, but is not limited to: **direct, indirect, special, incidental, consequential, punitive, or exemplary damages**, also including (without limitation) damages for loss of profits or revenue, business interruption, loss of data, procurement of substitute goods or services, or any claims by third parties.

The Licensor and Contributors shall not be liable for any claim, whether in contract, warranty, tort (including negligence), strict liability, or any other theory of liability, related to or arising from the Software or use of the Software. This limitation of liability applies to any and all causes of action, whether for breach of contract, breach of warranty, indemnification, infringement, or otherwise.

By using the Software, You acknowledge that the Licensor is **not responsible** if the Software fails or if its use causes any harm or loss. Specifically, You agree that the Licensor and Contributors will **not** be liable for any legal or financial consequences resulting from claims of intellectual property infringement (including patent infringement) brought against You by third parties due to your use of the Software. You are solely responsible for compliance with any laws and for any damage that results from your actions in connection with the Software.

_(In short: You can't recover any damages from the Licensor or contributors. If something goes wrong or someone sues you because you used this Software, that's on you, not on us.)_

## 14. Termination

**14.1 Termination for Violation:** This License and all rights granted to You under it terminate automatically if You violate any material term of the License. For example (and not limited to): if You use the Software in an unauthorized commercial way, fail to contribute required improvements, publicly deploy or distribute the Software without permission, use the Software for AI/ML Training, or use it in a forbidden governmental or public-facing capacity, You are in breach of this License. Upon breach, You must immediately cease all use of the Software and destroy all copies in your possession or control (including any modified versions).

**14.2 Notice and Cure (Opportunity to Comply):** As an exception to the automatic termination rule, if this is your first breach of the License and You receive written notice from the Licensor of the violation, You will have a period of **30 days** from receipt of notice to come back into full compliance with the License. During that period, your License is suspended, not terminated, and it will fully resume (as if no breach had occurred) only if: (a) You correct the violation and cease the offending conduct, and (b) You take concrete steps to remedy any harm caused by the violation (for example, if you improperly deployed the Software publicly, you withdraw it and ensure any recipients are informed it was unlicensed; if you failed to contribute changes, you submit them in full; etc.). If You do not cure the breach within the 30-day period, then your License **permanently terminates** on the 31st day after notice. The cure provision applies only to the first noticed breach; any subsequent breach by You may result in immediate termination without opportunity to cure.

**14.3 Effect of Termination:** Upon termination of this License for any reason, You must stop all use of the Software and refrain from any further use. Any provisions of this License which by their nature should survive termination (such as disclaimers of warranty, limitations of liability, the prohibition on AI/ML Training, and any perpetual licenses granted by You to the Licensor and others for your contributions, as well as the prohibition on unauthorized use or distribution of the Software) shall continue in effect. Termination of the License does not relieve You of liability for violations occurring before the License was terminated.

**14.4 No Refunds or Reinstatement:** Since the Software is provided free of charge under this License (for permitted uses), there is nothing to refund upon termination. Termination is without prejudice to any rights the Licensor may have to seek legal remedies for unauthorized use that occurred prior to termination. The Licensor may, at its sole discretion, reinstate a terminated License if it determines that you have sufficiently corrected past violations, but is under no obligation to do so.

## 15. General Provisions

**15.1 Governing Law:** This License is an intellectual property license, and not a contract signed by both parties; however, to the extent any dispute arises out of or in connection with this License, and to the extent not prohibited by applicable law, the laws of the jurisdiction of the Licensor's principal place of business (currently, the United States) shall apply, excluding its conflict-of-law provisions. If required, the controlling language of the License is English, and any translations are provided for convenience only.

**15.2 Severability:** If any provision of this License is held to be invalid, illegal, or unenforceable under applicable law, that provision shall be reformed and interpreted to accomplish the objectives of the original provision to the greatest extent possible under law, and the remaining provisions of this License shall continue in full force and effect. If such reformation is not possible, the invalid provision shall be deemed severed from this License, but this License shall otherwise remain in force.

**15.3 No Waiver:** No failure or delay by the Licensor in exercising any right, power, or remedy under this License shall operate as a waiver of any such right, power, or remedy. A waiver by the Licensor of any provision, or of any breach by You, shall not be deemed a waiver of any other provision or any subsequent breach of the same provision. All waivers must be in a signed writing to be effective.

**15.4 No Partnership or Agency:** This License does not create any partnership, joint venture, agency, or employment relationship between You and the Licensor. You are using the Software as an independent party and are not authorized to make any statements, representations, or commitments on behalf of the Licensor. You agree not to represent yourself as an agent or representative of Lumiverse or the Licensor to any third party.

**15.5 Entire License:** This License constitutes the entire and only agreement between the Licensor and You concerning the Software (subject to any separate written agreements for commercial or government use as discussed). It supersedes any prior proposals, agreements, or communications relating to the Software. The Licensor may publish updated or revised versions of this License from time to time, but such changes will not retroactively affect any rights already granted under this version unless You choose to adopt a new version by upgrading your copy of the Software or contributing code under the new version.

**15.6 Acceptance:** By exercising any permissions granted by this License (for example, by downloading, using, or modifying the Software), You indicate your acceptance of these terms and conditions. If You do not agree to all the terms, you have no license to use the Software.

**15.7 Export Control Compliance:** You acknowledge that the Software may be subject to U.S. and foreign export control laws and regulations. You agree to comply with all applicable international and national laws that apply to the Software, including the U.S. Export Administration Regulations, as well as end-user, end-use, and destination restrictions issued by the U.S. and other governments.

a. **Restricted Countries and Entities:** You represent and warrant that You are not located in, under the control of, or a national or resident of any country to which the export of the Software would be prohibited by applicable export control laws. Similarly, You represent that You are not on any denied-persons or restricted-entities list under applicable export control regimes.

b. **Restricted Uses:** You agree not to use the Software for any purposes prohibited by applicable export control laws, including but not limited to the development, design, manufacture, or production of nuclear, chemical, or biological weapons, or for missile technology.

c. **Classification:** The Licensor makes no representation or warranty regarding the export classification of the Software. You acknowledge that the export classification may change over time as the Software evolves, and it is Your responsibility to comply with applicable export regulations based on the current classification.

d. **Notification of Changes:** If You become aware of any potential export compliance issues related to Your use of the Software, You agree to promptly notify the Licensor.

e. **Indemnification:** You agree to indemnify and hold harmless the Licensor from any claims, losses, liabilities, or expenses arising from Your non-compliance with export control regulations.

This section shall survive the termination of this License. Nothing in this License relieves You of Your obligations to comply with applicable export control laws and regulations.

## 16. License Versioning and Updates

**16.1 Version Identification:** This Lumiverse Community License is designated as Version 2.2. Each version of the License will be clearly marked with a version number. The version number will be incremented for substantial changes to the License terms.

**16.2 License Updates:** The Licensor may publish updated or revised versions of this License from time to time. New versions will be similar in spirit to the present version but may differ in detail to address new concerns or issues. Each version will be distinguished by a unique version number.

**16.3 Applicability of License Versions:**

a. The version of the License under which You originally received the Software will continue to apply to Your use of that version of the Software, unless You choose to upgrade to a newer version as described below.

b. Updated License versions will automatically apply to new releases of the Software published after the updated License version takes effect.

c. When upgrading the Software to a newer version that is released under a newer License version, You must accept and comply with the terms of the newer License in order to use the upgraded Software.

**16.4 Upgrading to New License Versions:** If You wish to adopt a newer version of the License for Your existing copy of the Software:

a. You must explicitly indicate Your acceptance of the new License version, typically by upgrading to a Software version that uses the new License.

b. Once You have adopted a newer License version, You cannot revert to a prior version for that copy of the Software.

c. Your choice to adopt a newer License version does not obligate other users to do the same.

**16.5 Special License Transitions:** In some cases, the Licensor may decide to transition the Software to a different license entirely (such as an open-source license or a more restrictive license). In such cases:

a. Existing users will be notified at least 90 days in advance.

b. Existing users may continue using the version they have under the License terms that applied to it when they received it.

c. Alternative transition paths or options may be provided at the Licensor's discretion.

**16.6 License Version Repository:** An archive of all License versions will be maintained and made accessible via the Lumiverse project website for reference purposes. This ensures transparency and allows users to review changes between versions.

The Licensor strives to evolve the License in ways that better serve the community while maintaining the core principles and intentions described in the Preamble. Any questions about License versioning may be directed to the Licensor at **info@lumiverse.chat**.

---

_Copyright © 2025–2026 Darran Hall (Prolix OCs). All rights reserved._
